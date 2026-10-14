"""存档读写的回归测试（标准库 unittest，不引入新依赖）。

跑：cd 仓库根目录，然后
    python -m unittest discover -s tests -t . -p "test_*.py"

盯的是这几条：自动备份的保留份数与频次门槛、写入前后的原子性、
revision 冲突检测（多实例）、存档版本与坏字段的兜底。
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from backend import storage
from backend.app import create_app


class StorageTestBase(unittest.TestCase):
    """把可写目录换到临时目录 —— base_dir() 是 data_file() / backup_dir() 的唯一来源。"""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='posmax-test-')
        patcher = mock.patch.object(storage, 'base_dir', lambda: self.dir)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    # ---- 直接摆弄文件的小工具 ----
    def raw_path(self) -> str:
        return storage.data_file()

    def seed(self, data: dict) -> None:
        os.makedirs(os.path.dirname(self.raw_path()), exist_ok=True)
        with open(self.raw_path(), 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)

    def on_disk(self) -> dict:
        with open(self.raw_path(), 'r', encoding='utf-8') as f:
            return json.load(f)

    def backups(self) -> list[str]:
        directory = storage.backup_dir()
        if not os.path.isdir(directory):
            return []
        return sorted(n for n in os.listdir(directory) if n.endswith('.json'))


class TestSaveAndRevision(StorageTestBase):
    def test_first_save_writes_file_and_no_backup(self):
        # 盘上还没有存档，没什么可备份的
        result = storage.save({'projects': [], 'environments': []})
        self.assertEqual(result, {'revision': 1})
        self.assertEqual(self.on_disk()['revision'], 1)
        self.assertEqual(self.backups(), [])

    def test_successive_saves_bump_revision(self):
        storage.save({'projects': []})
        storage.save({'projects': []})
        result = storage.save({'projects': []})
        self.assertEqual(result['revision'], 3)

    def test_matching_base_revision_writes(self):
        storage.save({'projects': []})  # revision -> 1
        result = storage.save({'projects': [{'id': 'p1'}], 'baseRevision': 1})
        self.assertIsNotNone(result)
        self.assertEqual(self.on_disk()['projects'], [{'id': 'p1'}])

    def test_stale_base_revision_is_refused_and_writes_nothing(self):
        storage.save({'projects': [], 'environments': []})
        storage.save({'projects': [{'id': 'from-other-window'}], 'baseRevision': 1})

        # 另一个窗口拿的是旧基线：这次不写，也不能改动盘上的内容
        result = storage.save({'projects': [{'id': 'mine'}], 'baseRevision': 1})
        self.assertIsNone(result)
        self.assertEqual(self.on_disk()['projects'], [{'id': 'from-other-window'}])
        self.assertEqual(self.on_disk()['revision'], 2, '被拒绝的提交不该推进 revision')

    def test_force_overrides_conflict(self):
        storage.save({'projects': [], 'environments': []})
        result = storage.save({'projects': [{'id': 'mine'}], 'baseRevision': 999, 'force': True})
        self.assertIsNotNone(result)
        self.assertEqual(self.on_disk()['projects'], [{'id': 'mine'}])

    def test_payload_without_base_revision_still_writes(self):
        # 手工 curl 不该被冲突检查拦住
        storage.save({'projects': []})
        self.assertIsNotNone(storage.save({'projects': [{'id': 'x'}]}))

    def test_write_is_atomic_leaves_no_tmp(self):
        storage.save({'projects': []})
        leftovers = [n for n in os.listdir(os.path.dirname(self.raw_path())) if n.endswith('.tmp')]
        self.assertEqual(leftovers, [])

    def test_unknown_keys_on_disk_survive(self):
        # 更新的版本写了新字段，旧版本保存时不该把它抹掉（只覆盖自己认识的 key）
        self.seed({'projects': [], 'somethingNew': {'from': 'future'}})
        storage.save({'projects': [{'id': 'p1'}]})
        self.assertEqual(self.on_disk()['somethingNew'], {'from': 'future'})


class TestBackup(StorageTestBase):
    def test_backup_taken_before_overwrite(self):
        self.seed({'projects': [{'id': 'old'}], 'revision': 1})
        with mock.patch.object(storage, 'BACKUP_MIN_GAP_SECONDS', 0):
            storage.save({'projects': [{'id': 'new'}]})
        self.assertEqual(len(self.backups()), 1)
        with open(os.path.join(storage.backup_dir(), self.backups()[0]), encoding='utf-8') as f:
            self.assertEqual(json.load(f)['projects'], [{'id': 'old'}], '备份的是改动前的那份')

    def test_min_gap_skips_back_to_back_backups(self):
        self.seed({'projects': [], 'revision': 1})
        with mock.patch.object(storage, 'BACKUP_MIN_GAP_SECONDS', 300):
            for i in range(5):
                storage.save({'projects': [{'id': f'p{i}'}]})
        self.assertEqual(len(self.backups()), 1, '密集保存只留一份备份')

    def test_keeps_only_newest_ten(self):
        self.seed({'projects': [], 'revision': 1})
        directory = storage.backup_dir()
        os.makedirs(directory, exist_ok=True)
        # 先摆 12 份「很旧」的备份，文件名按时间排序
        for i in range(12):
            with open(os.path.join(directory, f'data-202001{i:02d}-000000.json'), 'w', encoding='utf-8') as f:
                json.dump({'projects': [], 'revision': i}, f)

        with mock.patch.object(storage, 'BACKUP_MIN_GAP_SECONDS', 0):
            storage.save({'projects': [{'id': 'new'}]})

        names = self.backups()
        self.assertEqual(len(names), storage.BACKUP_KEEP, f'只保留 {storage.BACKUP_KEEP} 份')
        self.assertNotIn('data-20200100-000000.json', names, '最旧的那些被删掉')
        self.assertEqual(names[-1][:5], 'data-', '新备份按名字排在最后')

    def test_backup_failure_does_not_break_save(self):
        self.seed({'projects': [], 'revision': 1})
        with mock.patch.object(storage, 'backup_dir', return_value='/proc/definitely/not/writable'):
            result = storage.save({'projects': [{'id': 'ok'}]})
        self.assertIsNotNone(result, '备份失败也必须写成')
        self.assertEqual(self.on_disk()['projects'], [{'id': 'ok'}])


class TestSchemaAndValidation(StorageTestBase):
    def test_version_and_history_limits(self):
        payload = {
            'projects': [],
            'version': 1,
            'history': [{'id': f'h{i}'} for i in range(250)],
        }
        storage.save(payload)
        data = storage.load()
        self.assertEqual(data['version'], 1)
        self.assertEqual(len(data['history']), storage.MAX_HISTORY)

    def test_wrong_type_falls_back_to_default(self):
        # 手改坏的字段不该原样透传给前端（前端的 .map / .length 会崩）
        self.seed({'projects': 'oops', 'environments': 42, 'history': {}, 'revision': 3})
        data = storage.load()
        self.assertEqual(data['projects'], [])
        self.assertEqual(data['environments'], [])
        self.assertEqual(data['history'], [])
        self.assertEqual(data['revision'], 3, '类型对的字段照常读出来')

    def test_missing_version_reads_as_default(self):
        self.seed({'projects': []})
        self.assertEqual(storage.load()['version'], storage.SCHEMA_VERSION)
        self.assertEqual(storage.load()['revision'], 0)

    def test_broken_file_falls_back_and_keeps_it(self):
        os.makedirs(os.path.dirname(self.raw_path()), exist_ok=True)
        with open(self.raw_path(), 'w', encoding='utf-8') as f:
            f.write('{ this is not json')
        self.assertEqual(storage.load()['projects'], [])
        self.assertTrue(os.path.exists(self.raw_path()), '坏文件要留着，好让人肉眼修')


class TestStateApi(StorageTestBase):
    def setUp(self):
        super().setUp()
        self.client = create_app().test_client()

    def test_put_returns_only_revision(self):
        res = self.client.put('/api/state', json={'projects': []})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json(), {'revision': 1})

    def test_stale_revision_gets_409(self):
        self.client.put('/api/state', json={'projects': [], 'environments': []})
        res = self.client.put('/api/state', json={'projects': [], 'baseRevision': 0})
        self.assertEqual(res.status_code, 409)
        self.assertTrue(res.get_json()['conflict'])

    def test_force_put_succeeds(self):
        self.client.put('/api/state', json={'projects': []})
        res = self.client.put('/api/state', json={'projects': [], 'baseRevision': 0, 'force': True})
        self.assertEqual(res.status_code, 200)

    def test_non_object_body_rejected(self):
        res = self.client.put('/api/state', json=[1, 2, 3])
        self.assertEqual(res.status_code, 400)


if __name__ == '__main__':
    unittest.main()

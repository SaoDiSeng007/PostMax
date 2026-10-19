#!/usr/bin/env bash
#
# 把 main 推到两个远端（gitee + github）。
#
# 为什么不能一句 git push 了事：
#   · gitee  走正常推送，保留完整提交历史。
#   · github 上只有一份「孤儿快照」，它与本地 / gitee 的历史互相独立，
#     普通 push 会被拒（non-fast-forward），只能重打一份快照强推过去。
#     绕这一下是为了保住 GitHub 自己加的那份 LICENSE —— 本地仓库不放这个
#     文件，而一旦用本地历史覆盖 GitHub，它就会消失。
#
# 两端**互相独立**：一边不通（代理、DNS 之类）不影响另一边照常推完，最后统一报结果。
# 哪端没成功，网络恢复后重跑本脚本即可 —— 已经推上去的那端会显示 up-to-date，不会重复推。
#
# 最后还有一步「附加」：把本机其它工作副本一起快进（见第 3 段）。
# 同一台机器上常常不止一份拷贝（换过工具、换过工作区，老目录还留着），而**跑着界面的
# 那一份往往不是这份**。只推远端不管本地副本的话，那边看起来就是「改了没生效」——
# 排查半天才发现看的是旧代码。要同步哪些目录写在 .sync-copies（见下），没有就跳过。
#
# 用法：
#   ./推送两端.sh                快照信息用「<最新提交主题>（快照）」
#   ./推送两端.sh "自定义信息"    自己指定
#
# .sync-copies（可选，仓库根目录，一行一个绝对路径，# 开头是注释）：
#   只对本机有意义，所以它被 gitignore 掉、不进仓库。示例（斜杠写成 / 最稳）：
#     C:/Users/PC/CodeBuddy/postmax
#
set -uo pipefail
cd "$(dirname "$0")"

MSG="${1:-PostMax：$(git log -1 --pretty=%s)（快照）}"
SNAP="__snapshot__"
failed=0

# ---- 1) gitee：正常推送，保留完整历史 ----
echo "[1/2] 推送到 gitee ..."
if git push gitee main; then
  echo "      gitee 已更新"
else
  echo "      gitee 没推上去（网络 / 代理？），先记下，继续处理 github"
  failed=1
fi

# ---- 2) github：把当前代码重打成一份孤儿快照强推 ----
echo "[2/2] 重建 github 快照 ..."
git branch -D "$SNAP" >/dev/null 2>&1 || true
git checkout --orphan "$SNAP" main >/dev/null 2>&1

# 把 GitHub 上那份 LICENSE 带进快照。它只存在于远端，本地没有也不打算有；
# 万一哪天被删了，跳过就好，别让脚本卡死。
if git cat-file -e "github/main:LICENSE" 2>/dev/null; then
  git checkout github/main -- LICENSE
else
  echo "      提示：github/main 上已没有 LICENSE，本次快照不含它。"
fi

if git commit -q -m "$MSG" && git push --force github "$SNAP:main"; then
  echo "      github 已更新"
else
  echo "      github 没推上去"
  failed=1
fi

# 无论成败都回到 main，别把工作区留在快照分支上；快照带出来的 LICENSE 也清掉
git checkout -q main
git branch -D "$SNAP" >/dev/null 2>&1 || true
rm -f LICENSE

# ---- 3) 附加：把本机其它工作副本一起快进 ----
#
# 直接从**当前这份**取，不走网络 —— 刚提交的东西本地就有，不必再去远端兜一圈，
# 也就不受代理 / DNS 的影响。一律 --ff-only：分叉了、或那边有未提交改动，就干脆
# 不碰，绝不替谁做合并，更不会丢东西。
if [ -f .sync-copies ]; then
  echo "[附加] 同步本机其它副本 ..."
  while IFS= read -r dir || [ -n "$dir" ]; do
    case "$dir" in '' | '#'*) continue ;; esac
    if [ ! -d "$dir/.git" ]; then
      echo "      跳过（不是 git 仓库）：$dir"
      failed=1
      continue
    fi
    if git -C "$dir" fetch -q "$PWD" main 2>/dev/null &&
      git -C "$dir" merge --ff-only -q FETCH_HEAD 2>/dev/null; then
      echo "      已快进：$dir"
    else
      echo "      没动（有未提交改动 / 已分叉 / 不在 main 上）：$dir"
      failed=1
    fi
  done < .sync-copies
fi

if [ "$failed" -eq 0 ]; then
  echo "完成：该更新的都更新了。"
else
  echo "有环节没成功（上面逐条标了）。处理完重跑本脚本即可 —— 已经到位的那部分不会重复推。"
  exit 1
fi

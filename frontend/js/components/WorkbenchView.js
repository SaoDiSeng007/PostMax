import { computed, defineComponent } from 'vue';
import Img2Base64 from './Img2Base64.js';
import WbTimestamp from './WbTimestamp.js';
import WbJson from './WbJson.js';
import WbRandom from './WbRandom.js';
import WbRegex from './WbRegex.js';
import WbHash from './WbHash.js';
import WbDiff from './WbDiff.js';
import { workbenchTool } from '../workbench.js';

/**
 * 工作台的主区：当前工具。
 *
 * 加工具只动两处 —— workbench.js 的清单里加一条，这里的 TOOL_VIEWS 里挂上组件。
 * 标题和说明统一由这一层渲染（从清单里取），工具组件只负责自己的输入和结果，
 * 免得每个工具各写一遍头部、写法还各不相同。
 *
 * 主区一次只显示一个工具（「点一个看一个」，见 WorkbenchPanel）：
 * 工具都是要正经用一下的，铺成一页的话每个只剩一条，等于都用不了。
 */
const TOOL_VIEWS = {
  img2b64: Img2Base64,
  ts: WbTimestamp,
  json: WbJson,
  random: WbRandom,
  regex: WbRegex,
  hash: WbHash,
  diff: WbDiff,
};

export default defineComponent({
  name: 'WorkbenchView',
  props: {
    /** 当前工具的 id。空串或对不上时落到清单第一个 */
    tool: { type: String, default: '' },
  },
  setup(props) {
    const meta = computed(() => workbenchTool(props.tool));
    const view = computed(() => TOOL_VIEWS[meta.value.id] || null);
    return { meta, view };
  },
  template: `
    <div class="wb">
      <div class="wb-head">
        <span class="wb-title">{{ meta.name }}</span>
        <span class="wb-desc">{{ meta.desc }}</span>
      </div>

      <div class="wb-body">
        <!--
          清单里有、但还没做出来的工具：说清楚是「还没做」，不要给一个空壳
          （点了没反应会让人以为页面坏了）
        -->
        <div class="empty" v-if="!view">
          <span class="empty-title">{{ meta.name }} 还没做</span>
          <span class="empty-hint">这个工具还在清单上排着，先用左边的其它工具</span>
        </div>

        <component :is="view" v-else />
      </div>
    </div>
  `,
});

import { defineComponent } from 'vue';

/**
 * 展开 / 收起的小三角。四处树共用：目录、方案、步骤、运行报告的每一遍。
 *
 * 以前有三种写法 —— 接口页是文字 `▶` 加 CSS 旋转，方案树是内联 SVG 加旋转，
 * 运行报告是 `▾ / ▸` 两个字符来回换。同一件事三份实现，改一处另两处不会跟着
 * 变；更麻烦的是文字箭头在不同字体下位置会偏，换个字体整列就对不齐了。
 *
 * 统一成一个「右向箭头旋转 90°」。形状上它还顺带表达了方向：收起时指右
 * （往里收），展开时指下。
 */
export default defineComponent({
  name: 'Caret',
  props: {
    open: { type: Boolean, default: false },
    /** 自己就是可点的按钮（方案树那样）。默认只作装饰，让父行去接点击 */
    btn: { type: Boolean, default: false },
    title: { type: String, default: '' },
  },
  template: `
    <span class="caret-box" :class="{ open, btn }" :title="title">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 6l6 6-6 6" />
      </svg>
    </span>
  `,
});

/**
 * 部署配置。只有这两行需要改。
 *
 * ENDPOINT — Apps Script 部署后得到的网页应用 URL，以 /exec 结尾（不是 /dev）。
 * TOKEN    — 在 Apps Script 编辑器里跑 setup() 后，执行记录里打印的 SURVEY_TOKEN。
 *
 * 两者留空时页面进入「预览模式」：题目照常渲染，但不保存任何答案。
 * 用来在后端就绪前先看版面。
 */
window.SURVEY_CONFIG = {
  ENDPOINT: '',
  TOKEN: '',
};

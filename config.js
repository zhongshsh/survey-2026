/**
 * 部署配置。只有 ENDPOINT 一行需要改。
 *
 * ENDPOINT — Apps Script 部署后得到的网页应用 URL，以 /exec 结尾（不是 /dev）。
 *            留空时页面进入「预览模式」：题目照常渲染，但不保存任何答案。
 *
 * 这里**没有** token，是刻意的：任何写进前端的密钥都会随 GitHub Pages 一起公开，
 * 于是它挡不住任何人，只是看起来像个秘密。真正的凭据是邀请码 —— 一人一个，
 * 不进这个仓库，只存在于各自的邀请链接和后端的 assignments 表里。
 */
window.SURVEY_CONFIG = {
  ENDPOINT: 'https://script.google.com/macros/s/AKfycbxVZdYQpD28_-fPi38-ELO7zEVBi86Zib5ksQM9StTpyjHI6t-m76KEj2KyS0Wao0RV_w/exec',
};

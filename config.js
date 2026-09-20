/**
 * 部署配置。每份问卷一个 Apps Script 端点。
 *
 * 分开部署的理由：judge 发出去之后就冻结了，而 quality 还要改好几版。
 * 共用一个部署的话，为 quality 改一行代码就得重新部署，正在答 judge 的人
 * 下一次请求就打到新逻辑上。两个端点、两张表，互不干扰。
 *
 * 值是 Apps Script「网页应用」URL，以 /exec 结尾（不是 /dev）。
 * 留空的那一份进入「预览模式」：题目照常渲染，但不保存任何答案。
 *
 * 这里没有 token，是刻意的：任何写进前端的密钥都随 GitHub Pages 一起公开。
 * 真正的凭据是参与者编号 —— 一人一个，不进这个仓库。
 */
window.SURVEY_CONFIG = {
  ENDPOINTS: {
    // 已冻结，发布后不要再动这个部署
    judge: 'https://script.google.com/macros/s/AKfycbxVZdYQpD28_-fPi38-ELO7zEVBi86Zib5ksQM9StTpyjHI6t-m76KEj2KyS0Wao0RV_w/exec',
    // 迭代中：新建一个独立的 Apps Script + Spreadsheet，把 /exec 填进来
    quality: '',
  },
};

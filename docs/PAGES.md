# GitHub Pages 图文站

入口为仓库根目录 [index.html](../index.html)，静态 HTML/CSS/JavaScript，无框架、字体 CDN、统计或后台依赖，可直接用浏览器打开。相对资源地址兼容项目子路径。

## 本地维护

1. 更新正文与使用指南，保留候选状态、安装风险及验收边界。
2. 执行 `node scripts/build-release.mjs`，三个下载 JSON 和 `site/release-data.js` 同时生成；兼容性行来自 `compatibility.json`，不要手改生成文件。
3. 执行 `node --experimental-vm-modules --test tests/*.test.mjs`。网站测试检查内部资源、章节锚点、三项特色功能的设置步骤、无下载入口、版本映射和截图格式。
4. 用桌面及手机视口复查导航、长文、FAQ 和图片。截图来源必须是可公开的合成数据，不能拿真实用户页面作底图。

三张当前演示截图的尺寸为 1280x720、390x844、360x800，均直接来自浏览器截图，没有修图。浏览器返回实际格式是 JPEG，文件使用对应 `.jpg` 扩展名；不可依据最初保存时的名称猜格式。
更换图片需要重新审查像素、元数据和摘要，不能仅靠文件名通过脱敏。当前图片不包含 EXIF、注释或个人位置数据。

## 获准上线之后

当前仅在本地准备，未启用 Pages。用户批准上传后，再在 GitHub 仓库 Settings > Pages 中选择 Deploy from a branch、`main`、`/(root)`。根目录的 `.nojekyll` 让 GitHub 直接发布静态文件，无需 Jekyll 或额外构建工作流。

预期地址为 `https://huayueshan.github.io/shujuku-scope-binding/`，此处是部署规划，不代表该 URL 已经可以访问。
规则依据 [GitHub 官方文档](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。

Pages 只负责介绍和使用说明，不提供下载方式。正式发行仍须提供三个独立的酒馆助手 JSON，以及固定版本标签；在线 JSON 的正文仍依赖发布后的 jsDelivr 地址。
网站随每个发行快照提交，不生成专属建站提交，不引入开发仓库历史。首次上线前确认候选/正式状态、许可、三种下载摘要及 CDN 返回值，禁止仅为使网页显示“正式发行”而改状态。

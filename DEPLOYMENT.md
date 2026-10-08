# GitHub Pages 部署

此应用无生产依赖，GitHub Actions 只运行测试、复制白名单静态文件并发布 `dist/`。完整仓库应以 **browser-app 文件夹为根目录**，不能把含数据库和凭据的旧项目根目录当作发布仓库。

## 从本地克隆发布

1. 目标仓库为 `JunYi0160/cycle-algorithm`，本机克隆目录为 `D:\Documents\GitHub\cycle-algorithm`。
2. 在克隆目录提交并推送更新，确认忽略规则生效：

   ```powershell
   cd D:\Documents\GitHub\cycle-algorithm
   git status --short
   git add .gitignore package.json README.md DEPLOYMENT.md .github public src scripts tests
   git diff --cached --name-only
   git commit -m "Add browser-based Cycle Algorithm"
   git push -u origin main
   ```

   检查待提交列表只有应用源码、部署脚本和虚构测试基准；不要加入 `private-exports/`、`tests/artifacts/`、`dist/`、`.env`、真实备份或账户数据。建议直接使用上方列明的目录，避免在旧项目根目录执行 git add。
3. 在仓库 Settings → Pages → Build and deployment，将 Source 设为 **GitHub Actions**。工作流文件为 `.github/workflows/pages.yml`。
4. 推送 main，或在 Actions 中手动运行 Publish Cycle Algorithm。流程测试通过后只上传 `dist/`，部署输出网站 URL。
5. 打开 `https://JunYi0160.github.io/cycle-algorithm/`，用完整 JSON 备份恢复数据。应用全部资源使用相对路径，无需更改仓库名配置。

GitHub 官方依据：[自定义 Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。工作流采用 `configure-pages@v5`、`upload-pages-artifact@v4`、`deploy-pages@v4`，部署 job 使用 `pages: write` / `id-token: write` 权限与 `github-pages` environment。

## 本地预检

```powershell
node --test tests/*.test.mjs
node scripts/build.mjs
node scripts/serve.mjs --base /any-repository-name/
```

打开 `http://127.0.0.1:8788/any-repository-name/`。日常网页只加载静态 HTML/CSS/JS/图标；CSP 的 `connect-src 'none'` 阻止应用发起网络数据请求。数据由浏览器保存，不会因 GitHub 部署自动上传。

## 当前交付状态

部署目标为 `JunYi0160/cycle-algorithm`，本机工作目录为 `D:\Documents\GitHub\cycle-algorithm`，origin 指向该仓库。应用构建、数值和浏览器验证已完成；发布状态以仓库 Actions / Pages 部署记录为准。真实迁移备份留在旧项目的 `C:\strategy-directus\browser-app\private-exports`，不上传仓库。

旧服务、数据库和旧网页均未改动；本地静态预览只为开发检查。发布后无需在本机维持预览服务。

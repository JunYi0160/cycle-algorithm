# GitHub Pages 部署

仓库：[JunYi0160/cycle-algorithm](https://github.com/JunYi0160/cycle-algorithm)。
页面：[Cycle Algorithm](https://junyi0160.github.io/cycle-algorithm/)。

公开数据和源码一同提交。页面加载 data/ 中的静态 CSV/JSON；账户和本次组合输入不属于仓库数据。

## 更新程序或数据

```powershell
npm run validate:data
npm test
npm run build
git diff --check
git add src public scripts tests data README.md DEPLOYMENT.md package.json
git commit -m "Update public strategy data"
git push origin main
```

Settings → Pages → Source 采用 GitHub Actions。现有 .github/workflows/pages.yml 在 main 更新后运行数据校验、测试、构建并发布 dist/。构建只复制校验后的白名单文件；数据变化也会产生新版本号。

浏览器编辑后先下载项目数据包，解压覆盖 data/，再执行上述检查和提交。网页没有 GitHub 写入接口或密钥。公开 JSON 也可以导入脚本转换为项目文件；旧账户、持仓、融资和自动任务会被丢弃。

不要提交 .env、旧数据库、private-exports、日志或旧完整备份。新 data/ 下的文件只包含公开市场数据及逐标的控制器状态。

## 预览与数据读取

```powershell
npm run build
node scripts/serve.mjs --base /any-repository-name/
```

静态资源和数据均使用相对路径，支持项目子路径。数据请求使用 no-store，每次打开读取项目中的已发布文件；本次输入和网页编辑只在内存中。已有页面发现更新会提示，避免丢失未导出的修改。

构建校验拒绝外部助手、本机数据服务和浏览器持久化调用。Content Security Policy 仅允许同源数据读取。

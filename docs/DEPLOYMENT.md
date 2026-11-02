# 验证与 GitHub Pages 发布

## 本地验收

需要 Node.js 22 或 24。安装开发依赖后运行：

```bash
npm ci
npm run format:check
npm run check
npm test
npm run build
npm run verify:build
npx playwright install --with-deps
npm run test:e2e
```

`--with-deps` 用于 Linux 测试机的系统依赖安装；其他平台可使用 `npx playwright install`。完整浏览器矩阵为桌面 Chromium、手机尺寸 Chromium、桌面 Firefox、手机尺寸 WebKit。手机尺寸是浏览器模拟，不代表真实设备认证。双指手势通过 Chromium 的触摸输入接口验证；其他引擎验证滚轮缩放。Chromium 测试使用实际剪贴板，其余引擎用剪贴板事件验证大批次粘贴处理。

浏览器测试的 npm 前置步骤会先构建应用。测试服务器只提供 `dist/` 中的公开文件，并挂载到 `/memory-galaxy/`，用于发现项目站点子路径中的资源引用问题。测试服务器不会复用同端口的其他进程。

只运行 Chromium：

```bash
npm run test:e2e -- --project=desktop-chromium --project=mobile-chromium
```

已有 Chromium 二进制时可设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`；额外启动参数通过 `PLAYWRIGHT_CHROMIUM_ARGS` 的 JSON 数组提供。这两个参数只影响 Chromium 项目。常规 CI 使用 Playwright 安装的浏览器，不需要这些覆盖参数。

## 构建产物

`npm run build` 复制页面、协议、图标和许可证，生成 `dist/build-info.json` 及 `.nojekyll`，然后验证完整产物。测试、依赖、本机配置、仓库元数据和报告不进入站点。公开目录中的未知文件或符号链接会使构建失败；发布前需明确处理，不能静默夹带到产物中。

构建清单使用 `memory-galaxy/build/1`，记录应用版本、协议版本、提交 SHA，以及每个公开文件的字节数和 SHA-256。未提交的公开源码或缺少 Git 信息时，revision 为 `null`；不会把本地改动标为已提交版本。可通过 `BUILD_REVISION` 显式提供完整 SHA，适用于调用方已经核验来源的归档构建。

```bash
npm run verify:build -- --revision <完整提交SHA>
npm run preview
```

预览地址是 `http://localhost:4173/memory-galaxy/`。清单检查会拒绝缺失、额外或被修改的文件。`.nojekyll` 是单独校验的空控制文件，不列入公开 HTTP 资源清单。

## 持续集成

`.github/workflows/ci.yml` 在 main 更新、面向 main 的 PR 和手动执行时运行：

1. 在 Node.js 22、24 上检查格式、源码、工作流 YAML、单元测试和构建完整性。
2. 在四个浏览器项目中测试构建产物，保留失败截图、跟踪和 HTML 报告。
3. 所有检查通过后上传 `site-dist`，便于下载复核。
4. 只有 main 的非 PR 运行可以上传 Pages 产物并发布。
5. 发布完成后，核对线上提交、完整文件哈希与 MIME，再执行线上浏览器冒烟检查。

PR 只获得 `contents: read`。Pages 和 OIDC 写权限仅授予发布作业；不使用 `pull_request_target`，不保存 checkout 凭据，也不需要个人访问令牌。外部 Actions 固定到完整提交 SHA，旁边标注对应版本；更新时应核对官方发布与新 SHA，再运行工作流验证。报告与复核产物保留 7 天。

main 的运行按顺序完成；新 PR 更新可取消旧运行。这样不会在发布过程中取消 main 作业，也不会让较旧的 main 构建晚于新构建覆盖站点。

## 首次启用 Pages

仓库所有者需要在 GitHub 的 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**。这是仓库设置，不等同于添加工作流文件。普通工作流的 `GITHUB_TOKEN` 不能首次启用 Pages；项目不通过扩大令牌权限解决这一步。

若 `github-pages` 环境配置了审核或分支限制，需允许 main；发布作业会遵守这些设置，不会绕过审核。本文提供的工作流只发布 main，开发分支的 PR 不会覆盖生产站点。首次发布需要工作流合并到 main 后触发，或在 main 上手动运行。

- [GitHub Pages 发布源设置](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [自定义 Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [configure-pages 的启用权限说明](https://github.com/actions/configure-pages/blob/main/action.yml)

## 线上验收

工作流会使用 `deploy-pages` 返回的实际站点地址，不根据仓库名称假定部署成功。也可手动检查：

```bash
npm run build
npm run verify:site -- --url https://站点地址/项目路径/ --revision <完整提交SHA> --manifest dist/build-info.json --attempts 6
```

`--manifest` 将线上清单与已知的本地产物逐项比对，避免只相信服务器自报的 revision。没有该参数时，只能确认线上清单及文件自洽，不能据此证明文件来自某个可信构建。检查拒绝路径越界、跨源重定向、响应过大、哈希错误和错误的 JavaScript / CSS / JSON / HTML MIME。有限次数重试用于发布后的 CDN 生效等待，不会把检查失败记作成功。

只执行部署冒烟检查：

```bash
PLAYWRIGHT_BASE_URL=https://站点地址/项目路径/ EXPECTED_REVISION=<完整提交SHA> npm run test:smoke -- --project=desktop-chromium --project=mobile-chromium
```

上例为 POSIX shell 写法；PowerShell 可先设置同名环境变量。冒烟用例验证入口跳转、样式、布局 Worker、导入 Worker、备份 Worker 和产品协议文本。测试使用独立浏览器上下文与虚构数据，不读取真实个人记忆，也不向服务端写入记忆。

CI 测试通过、产物上传成功和线上部署成功是三个不同结果。只有 Pages 发布及线上校验通过后，才应将地址标为已验证可用。具体执行记录以对应提交的 Actions 运行结果为准。

## 回退

在开发分支中对需要撤销的提交执行正常 revert，按同样的检查和 PR 流程合并到 main。新构建会带新的 revision，保留清晰的来源记录。不要强推、改写历史或绕过检查发布旧产物。

站点代码发布不会自动迁移、上传或清除用户浏览器里的记忆。更换域名或路径前，应先确认本机存储的来源范围，并提醒用户保管完整备份。

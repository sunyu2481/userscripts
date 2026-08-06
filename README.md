# userscripts

个人油猴脚本合集。每个脚本一个目录，自包含源码、测试、构建脚本和构建产物。

[访问 GitHub 仓库](https://github.com/sunyu2481/userscripts) · 所有脚本都带 `@updateURL`，发布新版后 Tampermonkey 会自动更新。

## 脚本列表

### [公益站自动签到助手](scripts/api-auto-checkin/)

在签到页上找到签到按钮并点击，一次点击依次处理多个站点。不预置站点类型，不拼接口地址，不主动发签到请求——签到请求全部由站点页面自己发出，脚本只是代替你点按钮。

- 支持 NewAPI / Sub2API / ZenAPI 之外的任意站点，只要页面有可识别的签到按钮
- 支持 hash 路由（`/#/checkin`）、仅访问模式、转盘 / 抽奖式签到
- 遇到人机验证或未登录会停下交给你，不尝试绕过
- 标签页默认保留供核对，支持一键关闭全部

**安装**：

```
https://raw.githubusercontent.com/sunyu2481/userscripts/main/dist/api-auto-checkin.user.js
```

点开这个地址，Tampermonkey 会弹出安装页面。装过一次后，脚本会用 `@updateURL` 跟踪 `main` 分支的 `dist/` 产物，以后发布新版会自动提示更新。

## 目录结构

```
userscripts/
├── build.js          # 构建全部或指定脚本，产物汇总到 dist/
├── test.js           # 跑全部或指定脚本的测试
├── package.json
├── scripts/          # 每个脚本一个目录
│   └── api-auto-checkin/
│       ├── README.md
│       ├── build.js
│       ├── src/      # 分片源码，按文件名顺序拼接
│       ├── test/     # node:test 用例
│       └── api-auto-checkin.user.js   # 构建产物
└── dist/             # 汇总的构建产物，装这里面的
```

## 开发

```bash
npm run build            # 构建全部脚本
npm test                 # 跑全部测试
node build.js <name>     # 只构建指定脚本
node test.js <name>      # 只跑指定脚本
```

### 加一个新脚本

1. 建目录 `scripts/<名称>/`
2. 里面放 `build.js`（把分片拼成 `<名称>.user.js`）、`src/`、`test/`、`README.md`
3. 根目录的 `build.js` 和 `test.js` 会自动发现并纳入

一个脚本目录只要包含 `build.js` 就会被根构建发现。每个脚本自包含，互不干扰。

## 约定

- 测试用 `node:test`，不引第三方依赖
- 测试跑的和构建产物是同一份代码（`test/load-src.js` 用 `new Function` 在主 realm 求值源码）
- 脚本默认不伪造请求、不绕过人机验证、不主动发签到请求
- 代码注释、README 用中文；标识符用英文
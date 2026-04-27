#!/usr/bin/env node
// 安全 env 转储器：被 daemon.sh 用 `node --env-file=$CONFIG dump-env.mjs` 调用。
//
// 设计意图：取代 daemon.sh 早先的 `set -a; source config.env` 写法。
// 后者会把 config.env 当 shell 脚本执行，配置文件里只要被注入
// `EVIL=$(rm -rf ~)`、`X=`...`` 等 payload 就会被 shell 解释执行，
// 等同于本地代码执行。
//
// 流水线：
// 1. Node 启动时 --env-file= 把 config.env 解析为纯 KEY=VAL（不执行任何
//    shell 语句，只是字面解析）放进 process.env。
// 2. 本脚本对比 --env-file 注入前后的 process.env diff，识别出所有源自
//    config.env 的键（无论前缀），输出 POSIX 风格、单引号包裹、带严格
//    转义的 `export KEY='value'` 行。
// 3. daemon.sh 用 `eval "$(node --env-file=... dump-env.mjs)"` 接收。
//    eval 的输入是这里生成的、确定性转义后的字符串，不是 config.env
//    原文，所以 config.env 中再怎么写命令替换/反引号都无法逃逸。
//
// 不在脚本里做白名单前缀过滤：单用户本地守护进程，config.env 本就该
// 由用户自由控制。脚本职责仅限于"杜绝 shell 注入"，环境变量本身的
// 取舍交还给用户。

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/i;

// daemon.sh 在调用本脚本前，把已经存在于父 shell 的环境变量名以
// 换行分隔写入 CTI_DUMP_BASELINE_KEYS。脚本只会输出"基线之外"的键，
// 也就是 --env-file 真正从 config.env 引入的那些。这样既不需要前缀
// 白名单，又能避免把父 shell 自带的一切都重复 export 一遍。
const baselineRaw = process.env.CTI_DUMP_BASELINE_KEYS || '';
const baseline = new Set(baselineRaw.split('\n').filter(Boolean));
// CTI_DUMP_BASELINE_KEYS 自身只是传递通道，不应被 eval 出去。
baseline.add('CTI_DUMP_BASELINE_KEYS');

// POSIX 单引号字符串里只有 `'` 一个特殊字符。把每个 `'` 替换为 `'\''`
// （结束当前单引号字符串 → 转义一个字面 `'` → 重新开始单引号字符串）
// 即可安全包裹任意字节序列（含 `$`、反引号、`\n` 等）。
function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

for (const [key, value] of Object.entries(process.env)) {
  if (value == null) continue;
  if (baseline.has(key)) continue;
  // 防御：仅接受合规 shell 变量名，杜绝任何形式的奇怪 KEY 进入 eval。
  if (!KEY_PATTERN.test(key)) continue;
  process.stdout.write(`export ${key}=${shellEscape(value)}\n`);
}

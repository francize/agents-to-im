# Feishu / Lark Credential Validation

写完 `config.env` 后，先验证 Feishu/Lark 凭据，再启动 bridge。这样能尽早发现 App ID、App Secret 或域名填错的问题。

```bash
APP_ID="${CTI_FEISHU_APP_ID}"
APP_SECRET="${CTI_FEISHU_APP_SECRET}"
if [ "${CTI_FEISHU_DOMAIN:-}" = "lark" ]; then
  DOMAIN="https://open.larksuite.com"
else
  DOMAIN="https://open.feishu.cn"
fi
```

## 1. 校验租户访问令牌

```bash
curl -s -X POST "${DOMAIN}/open-apis/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d '{"app_id":"'"${APP_ID}"'","app_secret":"'"${APP_SECRET}"'"}'
```

预期结果：
- 返回 JSON 中包含 `"code":0`
- 返回体中包含 `tenant_access_token`

如果失败，优先检查：
- `CTI_FEISHU_APP_ID`
- `CTI_FEISHU_APP_SECRET`
- `CTI_FEISHU_DOMAIN` 是否与应用所在区域匹配

如果你还要执行第 2 步，把上一步返回 JSON 里的 `tenant_access_token` 复制到 `TENANT_ACCESS_TOKEN` 环境变量里即可。

## 2. 可选：校验应用已开通的 app scopes

只有在应用已开通 `application:application:self_manage` 时，这个检查才会成功；否则 bridge 会在启动时降级为动作级报错，不影响启动。

```bash
curl -s "${DOMAIN}/open-apis/application/v6/applications/me?lang=zh_cn" \
  -H "Authorization: Bearer ${TENANT_ACCESS_TOKEN}"
```

预期结果：
- 返回 JSON 中包含 `"code":0`
- `data.app.scopes` 中至少能看到 IM 消息、群聊管理、CardKit，以及你在 [setup-guides.md](setup-guides.md) 里导入的主要业务权限

如果这里失败但第 1 步成功，说明：
- 核心凭据通常没问题
- 但应用自检能力不足，bridge 的 scope 诊断只能退化为运行时 API 错误提示

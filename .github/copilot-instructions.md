---
description: "率土之滨藏宝阁账号评估项目的全局规则:账号筛选、武将库匹配、队伍强度评分、战法宝物复核、补件分析、最终购买建议、浏览器操作。"
---

# 率土之滨藏宝阁账号评估 — 全局规则

## 一、核心规则

### 文件与命名
- **目录结构**(2026-10-25 整理):
  - `docs/` — 规范/流程/模板 + 榜单(`docs/队伍强度排行榜.md`)+ 榜单分段图片;索引见 `docs/README.md`;历史报告已移到 `reports/legacy/`
  - `data/` — 配置单源 `data/strategy-config.json`、采集数据(最终汇总 `data/accounts-final.json`)、队伍库 `data/teams.json`、运行元数据 `data/run-meta.json`(gitignore);备份/旧快照(`data/backups/`、`*.bak.json`)不进 git
  - `scripts/` — 主链路脚本;公共库:`lib-config.js`/`lib-config.ps1`(配置单源,禁止脚本写死阈值)、`lib-shishi.js`、`lib-runmeta.js`、`lib-scoring.js`、`plan5-core.js`;历史脚本归档在 `scripts/legacy/`,不要在新流程调用
  - `reports/` — 策略评估输出(`reports/策略落地-*/`、`reports/筛选条件策略-*/`)+ 历史报告归档 `reports/legacy/`
  - `README.md` — 项目总览/快速开始/配置说明/FAQ/免责声明
- **自动化主链路**:`npm run shishi`(白名单)→ `npm run find`(api-collect → merge-api → report.js)→ `npm run strategy`;离线回归 `npm test`(verify-shishi + verify-core);CI `.github/workflows/test.yml` 不联网、不采集
- **provenance**:账号记录必须带 `source`(api/browser)/`capturedAt`/`statusKind`(由 `l0_data.statusLabels` 归一化),超 `maxStaleDays` 标注旧快照;`sold`/`delisted` 不进推荐
- 命名:候选文档 `{描述}-{日期}.md`;最终建议 `最终购买建议-{特性}-{日期}.md`;数据 `{阶段}-{版本}.json`;脚本 `{阶段}-{版本}.ps1`
- 脚本一律用 `$PSScriptRoot`/`require('path')` 相对定位(docs/data),禁止硬编码 `D:\WorkSpace` 路径

### 同名异版本武将硬规则
- 弓诸葛 ≠ 普通诸葛亮;榜单司马懿(晋) ≠ 普通魏司马懿
- 带 S2/S3/XP/SP/晋/汉等版本含义的武将,不能被普通同名武将顶替
- 匹配必须看原始武将卡文本的版本上下文,不能只看名字命中;违反会导致排序重算

### 评估流程
- 第一轮:只按武将库做理论匹配,不看战法宝物
- 第二轮:只对 shortlist(≤5 个)复核战法与宝物
- 最终建议:区分「到手即战力」「只补宝物短期成长」「长期潜力」
- 武将、战法补件成本高/周期长,不纳入短期方案;宝物是唯一默认允许的短期补件方向

### 评分权重与阈值(唯一来源 `data/strategy-config.json`)
- **禁止在本文件/脚本/提示词里另抄一套权重**;需要数值时从配置读取,或写明"以配置为准"
- `l3_scoring.tierWeight`(2026-10-25):T0+=10、T0=8、T1=5、T2-=2;只缺宝 ×0.8(`onlyGearFactor`)、缺战法 ×0.2(`missTacticFactor`)
- 版本武将/跳过武将:`versionOverrides`(如"司马懿"要求晋)、`skipHeroes`(弓诸葛无数据跳过)
- 硬规则 `hardRules`:高 T 缺战法≥2 降权、只缺宝缺≥3 ×0.3、溢价门槛(`premiumOver`:价格>2000 需完整 T1+≥1 且 T0 只缺宝≥1)
- 入选 gate(2026-10-25 重标定):`minFullT1plus`=4;alt(1 完整 + 3 只缺宝 T1+);alt2_baobao(4 只缺宝 T1+ 且真成长≥2);画像 `profiles`(即战型/均衡型/补宝型)。旧 `2/1+2` 按旧口径标定,统一引擎修复「二选一当全必选」后过松,已重标定
- L2 列表门槛/预算在 `l2_list_filter`(五星≥85、S战法≥20、锻造≥15、稀世≥10、详情预算 40);数据时效在 `l0_data`(`maxStaleDays`=14)
- 榜单以 `docs/队伍强度排行榜.md` 为准(2026 第三季度版),脚本解析产物为 `data/teams.json`

### 最终排序
- 短期强度接近时优先选便宜的;低价已够玩就不为远期潜力溢价
- 已完整落地 = 武将+战法+宝物齐;"只缺宝物" = 短期最有补件价值;"缺战法" = 短期不指望;"战法宝物都缺" = 降权

### 决策矩阵
- shortlist 最终排序用 `docs/决策矩阵模板.md`
- 六维加权:到手队数30% + 补宝新增15% + 武将库20% + 价格20% + 资产10% + 版本5%(人工打分模板;批量自动排序以 `npm run strategy` 的配置口径为准)
- 评分前必须逐队复核武将/战法/宝物的落地状态

## 二、浏览器操作(强制)

- **严禁随意新建页面**:先检查当前可用页面优先复用;卡死/弹窗先关弹窗或返回,再开新页
- 每次切换页面后先读一次快照确认位置,再执行下一步
- **数据提取用 `read_page` 快照 + PowerShell 解析**,不要用 `run_playwright_code`(只返回快照不返回 JS 结果)
- **滚动用 `key="PageDown"` 连续按直到快照不再变化**;`End` 键在 CBG 无效
- 点筛选/按钮用 `click_element` 传 `ref`;填输入框用 `type_in_page` 传 `ref`+`text`
- 提取详情页武将:只在「全阵营」到「仅展示4星及以上武将」之间截取,排除「猜你喜欢」区
- 提取结果去噪声:`"N"`/`"1"`/侍卫/麦子/陶渊明/朱士行/张恭/九色鹿/长风破浪/新春侍女/率土十载/不负时代/百家纵横
- PowerShell 长输出用 `> file.txt` 重定向后再读;Select-String 路径含特殊字符搜不到时改用完整路径或直接读文件

## 三、自进化

- 犯错被纠正、发现新坑、找到更好做法、用户要求记住 → 更新本文件:改对应规则段,并在文末「自进化日志」追加条目
- 本文件必须保持精简,防止占用过多上下文

### 自进化日志

| 日期 | 教训 |
|------|------|
| 2026-05-24 | 严禁随意新建页面,先检查当前可用页面优先复用 |
| 2026-05-24 | 数据提取用 read_page+PowerShell,run_playwright_code 只返回快照不返回 JS 结果 |
| 2026-05-24 | 提取详情页武将须在「全阵营」与「仅展示4星」之间截取,排除推荐区,并去除非武将噪声 |
| 2026-05-24 | CBG 页面 End 键无效,必须连续 PageDown 直到快照不再变化 |
| 2026-05-24 | 第一轮只做武将库理论匹配,不能混入战法宝物信息 |
| 2026-05-24 | 应先筛选缩小到 ~10 个候选再开详情页;加武将条件后确认 URL 含全部预期武将 ID |
| 2026-08-07 | 榜单更新为第三季度:打火机/狗刀降级 T2-(计 1 分),蛋兵衡轲刀改名衡轭菜刀;评分脚本已参数化 -DataPath 并支持 T2-,列表页初筛用 find-accounts-20260807.ps1(资产指数) |
| 2026-08-07 | **详情页武将必须切「星级(5星)」筛选再提取**:默认视图含4星+5星,白板5星与4星文本相同(如"群N袁术")无法靠文本区分;4星被当5星会致铁王八等队伍全部误判、得分虚高 |
| 2026-08-07 | 5星武将库提取用 evaluate DOM(定位"星级(5星)"标签→父级module→letterModule列表容器→卡片textContent取名字),比 read_page+PowerShell 解析可靠;提取范围到「猜你喜欢」推荐区前为止 |
| 2026-08-07 | **曹操必须校验魏阵营**:排行榜所有"曹操"均为五星魏曹操,汉曹操(汉极N)/四星曹操不能顶替;否则螃蟹队/三典藏/龙虎骑等含曹操队伍全部误判。采集marks含阵营(魏/汉/群),analyze用versionReq '曹操'='魏' 校验。类似教训:汉荀彧/XP姜维等版本武将均需校验 |
| 2026-08-07 | **关羽必须校验蜀阵营**:排行榜所有"关羽"默认蜀关羽,魏关羽(魏N/魏极N)不能顶替;否则豹纹刀(曹彰)/合纵蜀骑/五虎队/变种虎豹骑/雨化田/徐庶蜀骑/关羽砍王等含关羽队伍全部误判(52号里21号是魏关羽,X5860也中招)。6个脚本versionReq均已加 '关羽'='蜀'。**SP赵云已确认**:排行榜所有"赵云"均为SP赵云(用户确认),6脚本已加 '赵云'='SP' + Normalize 'SP赵云'='赵云'(修复定军赵一直匹配不上的问题;五虎队/赵维机/蜀刀也要求SP) |
| 2026-08-07 | **浏览器采集 server-price 去重会漏号**:同 server 同价格的不同商品(不同 ordersn)会被当重复跳过(1500-2500 列表 284 卡,浏览器只采 126 个,实际唯一商品 140+,漏 26 个含 114 分神号)。**API 直采成功(api-collect.js)**:列表 POST /cgi-bin/recommend.py?act=recommd_by_role(筛选在 POST body,page=N 翻页 count=15,150个;卡片字段 game_ordersn/server_name/price/desc_sumup_short)+ 详情 POST /cgi/api/get_equip_detail(serverid=1&ordersn=xxx;equip_desc JSON 字符串含 card[](武将280)/skill[](战法148)/gear[](宝物58));**页面内 fetch 自动带 cookie/referer/会话,几分钟采完全部**(context.request 缺 referer 会失败)。**坑**:API 的 card 含 4星武将且 quality 不是星级(4星武将是 q5),country 也不是阵营(曹操=1 吕布=1);需用「浏览器5星武将名 ∪ 榜单武将名」白名单过滤,版本武将(关羽/曹操/赵云/董卓/荀彧/孙坚/刘备/吕布/姜维/司马懿)用 hero_id 特判表(merge-api.js) |
| 2026-08-07 | 第三季度榜单为**四档**(T0+/T0/T1/T2-),无T0-;T2-段带配置41支,T1追加5支仅标题(王异法刀等)。OCR高频错词:坚实→垒实/洙水泞水→浑水/今无→令无/晓锐→骁锐/别鸣→别铭/敏众→敛众。豹纹刀截图重复拆分为「豹纹刀(曹彰)(曹纯)」(半角括号,防脚本去全角括号)。**t0-hero-count 踩坑:foreach 循环内 `$t0=@()` 会覆盖外层队伍数组(PowerShell同作用域)→ 收集变量改名 t0List** |
| 2026-08-07 | **链路优化v2(一键找号)**:merge-api.js 重构为「API 主链路 + 静态表」——不再依赖浏览器 detail 数据。静态表 data/name-camp.json(134武将→阵营唯一映射)+ data/star5-names.json(195五星白名单)+ 内置 hero_id 特判。浏览器 detail 只做可选增强且**只读最大的 accounts-detail-*.json**(旧价格段批次文件是中间产物可能已下架,会污染排名,已归档 data/tmp/detail-旧批次/)。**find-all.ps1 一键全流程**:api-collect(几分钟) → merge-api → report;ps1 必须 UTF-8 BOM 否则中文乱码(node 输出的日志用英文避免管道乱码) |
| 2026-08-07 | **🚨 重大教训:API 的 quality 字段才是真实星级**!quality===5 才是五星,quality=4 是四星(曹彰/于禁/四星关羽/四星魏曹操都是 quality=4)。**严禁用名字白名单(star5-names)过滤 API 武将**——四星同名武将(四星关羽/四星曹操/四星曹彰)名字也在白名单里,会全部混入导致分数虚高(曾把 30 分号误判成 114 分!)。merge-api.js 已改为 `filter(h=>h.quality===5)`,并额外校验 API 补号须真实五星>=85 且宝物>=12(API 列表筛选参数 five_star_hero_count 实际未生效,采回大量五星不足的号;且部分号 heroes 为空已剔除)。**验证方法**:浏览器号与 API 号重合时 heroCount 必须一致(API 详情非空时已验证 35/35 全一致,证明浏览器 5星采集可靠) |
| 2026-08-07 | **🚨 数据源限流教训:藏宝阁账号级风控(eb-re410)**。密集采集(125个详情批量/连续翻页)会触发账号级限流,列表+详情接口同时挂,持续 30 分钟+。**页面 DOM 也依赖接口**,限流时页面同样加载不出商品。**唯一可靠做法**:①慢速串行采集(详情间隔 3-4 秒,绝不并发批量)②连续失败>=3 自动长退避(60-120秒)③常态复用缓存数据,只做增量。**列表页 DOM 已验证**:每个卡片显示约10个核心武将(带准确版本:魏极XP曹彰/蜀SP赵云/魏极3N曹操),与完整详情完全一致,可做全量初筛(判断核心队伍)但看不到完整卡池。**desc 五星数与详情 quality=5 数量 100% 一致**,列表接口可精确初筛 |
| 2026-08-10 | **核心库抽取 plan5-core.js**:榜单解析/版本校验/落地判断/5队规划 统一抽到 scripts/plan5-core.js(initTeams/teamLandStatus/bestCombination/planAccount/landStatusList),plan5-node.js 与 land-stats.js 改为 require 复用(输出 100% 一致验证通过)。**recommend.js 已集成 5 队规划表**:生成的最终购买建议文档自动带每个账号「5队规划表」(队伍/档位/武将/落地✅完整🟡只缺宝🔴缺战法/缺战法/缺宝物),以后跑 recommend.js 出的文档都自带 5 队详情,无需手动整理。byKey 兼容价格字符串'1,900'与数字1900双 key |

## 四、试师服务器白名单

- 筛选只允许白名单区服:全量清单见 `docs/试师赛季白名单.md`,当前开放区服见 `data/shishi-open.json`(均由 `npm run shishi` 自动生成,勿手改)
- 采集脚本统一经 `scripts/lib-shishi.js` 读 `data/shishi-open.json`,禁止再写死 serverid;刷新原理与校验见 `docs/试师数据源.md`

import { App, LogLevel, ExpressReceiver } from '@slack/bolt';
import { LinearClient, PaginationOrderBy } from '@linear/sdk';
import * as dotenv from 'dotenv';
import * as bodyParser from 'body-parser';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

// Initialize Linear Client
const linearClient = new LinearClient({
    apiKey: process.env.LINEAR_API_KEY,
});

// Initialize Express Receiver for Webhooks
const receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET || 'test', // Fallback for dev
    processBeforeResponse: true
});

// Use custom body parser for webhook handling
receiver.router.use(bodyParser.json());

// Initialize Slack Bolt App with Socket Mode AND Receiver
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: (process.env.LOG_LEVEL as LogLevel) || LogLevel.INFO,
});

// Helper: Get Linear User by Email
async function getLinearUserByEmail(email: string) {
    const me = await linearClient.viewer; // Check connectivity
    const users = await linearClient.users({
        filter: {
            email: {
                eq: email
            }
        }
    });

    if (users.nodes.length === 0) {
        return null;
    }
    return users.nodes[0];
}

// Helper: Get Current Active Cycle
async function getCurrentCycle(teamId: string) {
    const cycles = await linearClient.cycles({
        filter: {
            team: {
                id: {
                    eq: teamId
                }
            },
            isActive: {
                eq: true
            }
        }
    });

    if (cycles.nodes.length > 0) {
        return cycles.nodes[0];
    }

    // Fallback: Try to find upcoming cycle if no active cycle
    const upcomingCycles = await linearClient.cycles({
        filter: {
            team: {
                id: {
                    eq: teamId
                }
            },
            endsAt: {
                gt: new Date().toISOString()
            }
        },
        first: 1
    });

    if (upcomingCycles.nodes.length > 0) {
        return upcomingCycles.nodes[0];
    }

    return null;
}

// -------------------------------------------------------------
// HELPER: Thread Mapping Store (Local JSON)
// -------------------------------------------------------------
const THREAD_MAP_FILE = path.join(__dirname, '../thread_map.json');

interface ThreadMap {
    [issueIdentifier: string]: {
        channelId: string;
        threadTs: string;
    };
}

const ThreadMappingStore = {
    load: (): ThreadMap => {
        try {
            if (fs.existsSync(THREAD_MAP_FILE)) {
                return JSON.parse(fs.readFileSync(THREAD_MAP_FILE, 'utf-8'));
            }
        } catch (e) {
            console.error("Failed to load thread map", e);
        }
        return {};
    },
    save: (data: ThreadMap) => {
        try {
            fs.writeFileSync(THREAD_MAP_FILE, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error("Failed to save thread map", e);
        }
    },
    get: (issueIdentifier: string) => {
        const data = ThreadMappingStore.load();
        return data[issueIdentifier];
    },
    set: (issueIdentifier: string, channelId: string, threadTs: string) => {
        const data = ThreadMappingStore.load();
        data[issueIdentifier] = { channelId, threadTs };
        ThreadMappingStore.save(data);
    }
};

// -------------------------------------------------------------
// FEATURE: Slack -> Linear Comment Sync
// -------------------------------------------------------------
app.message(async ({ message, client }) => {
    // 1. Ignore bot messages / subtype messages (like thread_broadcast)
    if ((message as any).subtype || (message as any).bot_id) return;

    // 2. Check if in a thread (has thread_ts)
    if (!(message as any).thread_ts) return;

    try {
        const threadTs = (message as any).thread_ts;
        const channelId = (message as any).channel;
        const text = (message as any).text;
        const user = (message as any).user;

        // 3. Get Root Message to find Issue ID
        const history = await client.conversations.replies({
            channel: channelId,
            ts: threadTs,
            latest: threadTs,
            limit: 1,
            inclusive: true
        });

        const rootMessage = history.messages?.[0];
        if (!rootMessage || !rootMessage.text) return;

        // Extract Issue Identifier: e.g., "[1SW-123]" or "(1SW-123)" or plain "1SW-123"
        const match = rootMessage.text.match(/\b([A-Z0-9]+-\d+)\b/);
        if (!match) return;

        const issueIdentifier = match[1];
        const lastDashIndex = issueIdentifier.lastIndexOf('-');
        const teamKey = issueIdentifier.substring(0, lastDashIndex);
        const issueNumber = parseInt(issueIdentifier.substring(lastDashIndex + 1), 10);

        console.log(`[Sync] Found Reply to Issue ${issueIdentifier} (Key: ${teamKey}, No: ${issueNumber})`);

        // 4. Find Linear Issue
        const issues = await linearClient.issues({
            filter: {
                number: { eq: issueNumber },
                team: { key: { eq: teamKey } }
            }
        });

        if (issues.nodes.length === 0) return;
        const issue = issues.nodes[0];

        // 5. Create Comment on Linear
        // Get user name for better context
        const userInfo = await client.users.info({ user });
        const userName = userInfo.user?.real_name || "Slack User";

        if (text) {
            await linearClient.createComment({
                issueId: issue.id,
                body: `${text}\n\n_(from Slack by ${userName})_`
            });
            console.log(`[Sync] Posted comment to Linear Issue ${issueIdentifier}`);
        }

    } catch (error) {
        console.error(`[Sync Error s->l]`, error);
    }
});


// -------------------------------------------------------------
// FEATURE: Linear -> Slack Bidirectional Sync (Webhook)
// Endpoint: /linear/webhook
// -------------------------------------------------------------
receiver.router.post('/linear/webhook', async (req, res) => {
    // Acknowledge immediately
    res.status(200).send();

    try {
        const body = req.body;
        const { action, type, data } = body;

        // Filter: Only care about Issue Updates or Comment Creates
        if (type !== 'Issue' && type !== 'Comment') return;

        // 1. Identify the Issue Identifier
        let issueIdentifier = '';
        let messageText = '';

        if (type === 'Issue' && action === 'update') {
            // E.g. Status change
            const stateId = data.stateId;
            const previousStateId = body.updatedFrom?.stateId;

            if (stateId && previousStateId && stateId !== previousStateId) {
                const issue = await linearClient.issue(data.id);
                const state = await issue.state;

                issueIdentifier = issue.identifier;
                messageText = `🛠️ *상태 변경*: ${state?.name}`;
            } else if (data.assigneeId && body.updatedFrom?.assigneeId !== undefined) {
                // Assignee changed
                const issue = await linearClient.issue(data.id);
                const assignee = await issue.assignee;
                issueIdentifier = issue.identifier;
                messageText = `👤 *담당자 변경*: ${assignee ? assignee.name : 'Unassigned'}`;
            }

        } else if (type === 'Comment' && action === 'create') {
            const commentBody = data.body;
            // Loop Prevention: If comment contains "(from Slack by ...)", ignore it
            if (commentBody?.includes('(from Slack by')) return;

            const issue = await linearClient.issue(data.issueId);
            const user = await linearClient.user(data.userId);

            issueIdentifier = issue.identifier;
            messageText = `💬 *새로운 댓글 (${user.name})*:\n${commentBody}`;
        }

        if (!issueIdentifier || !messageText) return;

        console.log(`[Sync] Webhook received for ${issueIdentifier} - ${messageText}`);

        // 2. Find Slack Thread
        // Strategy: Try ThreadMappingStore first, then fallback to search.messages
        let channelId: string | undefined;
        let threadTs: string | undefined;

        const mapped = ThreadMappingStore.get(issueIdentifier);
        if (mapped) {
            channelId = mapped.channelId;
            threadTs = mapped.threadTs;
            console.log(`[Sync] Found mapped thread for ${issueIdentifier}`);
        } else {
            console.log(`[Sync] No map found for ${issueIdentifier}, trying search...`);
            const searchResult = await app.client.search.messages({
                query: `"${issueIdentifier}"`, // Quote for exact phrase
                sort: 'timestamp',
                sort_dir: 'desc',
                count: 1
            });

            const match = searchResult.messages?.matches?.[0];
            if (match) {
                channelId = match.channel?.id;
                threadTs = match.ts;
                // Auto-save mapping for future
                if (channelId && threadTs) {
                    ThreadMappingStore.set(issueIdentifier, channelId, threadTs);
                }
            }
        }

        if (channelId && threadTs) {
            await app.client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: messageText
            });
            console.log(`[Sync] Updated Slack thread for ${issueIdentifier}`);
        } else {
            console.log(`[Sync] Could not find Slack thread for ${issueIdentifier}`);
        }

    } catch (error) {
        console.error(`[Sync Error l->s]`, error);
    }
});


// Slack Command Handler
app.command('/이슈!', async ({ command, ack, respond, client }) => {
    console.log(`[Debug] Command received: ${command.command} with text: ${command.text}`);
    await ack();

    const title = command.text.trim();
    if (!title) {
        await respond({
            text: "❌ 제목을 입력해주세요. 예: `/이슈! 로그인 버그 수정`",
            response_type: 'ephemeral'
        });
        return;
    }

    try {
        // 1. Get Slack User Info (Email)
        const slackUser = await client.users.info({ user: command.user_id });
        const userEmail = slackUser.user?.profile?.email;

        if (!userEmail) {
            await respond({
                text: "❌ Slack 프로필에서 이메일을 찾을 수 없습니다.",
                response_type: 'ephemeral'
            });
            return;
        }

        // 2. Match Linear User
        const linearUser = await getLinearUserByEmail(userEmail);
        if (!linearUser) {
            await respond({
                text: `❌ Linear에서 이메일(${userEmail})에 해당하는 사용자를 찾을 수 없습니다.`,
                response_type: 'ephemeral'
            });
            return;
        }

        // 3. Get Team and Cycle
        let teamId = process.env.LINEAR_TEAM_ID;
        if (!teamId) {
            await respond({
                text: "❌ 서버 설정 오류: LINEAR_TEAM_ID가 설정되지 않았습니다.",
                response_type: 'ephemeral'
            });
            return;
        }

        console.log(`[Debug] Using Team Identifier: ${teamId}`);

        // Support Team Identifier (e.g. '1SW') by fetching the actual team UUID
        if (teamId.length <= 5) {
            try {
                const team = await linearClient.team(teamId);
                if (team) {
                    teamId = team.id;
                    console.log(`[Debug] Resolved Team ID: ${teamId}`);
                } else {
                    throw new Error(`Team with identifier '${teamId}' not found.`);
                }
            } catch (err) {
                await respond({
                    text: `❌ Linear 팀(${teamId})을 찾을 수 없습니다. Identifier를 확인해주세요.`,
                    response_type: 'ephemeral'
                });
                return;
            }
        }

        const currentCycle = await getCurrentCycle(teamId);
        console.log(`[Debug] Current Cycle: ${currentCycle ? currentCycle.number : 'None'}`);

        // 4. Create Issue
        const issuePayload: any = {
            teamId: teamId,
            title: title,
            assigneeId: linearUser.id,
            stateId: undefined,
        };

        if (currentCycle) {
            issuePayload.cycleId = currentCycle.id;
        }

        const issueCreate = await linearClient.createIssue(issuePayload);
        const issue = await issueCreate.issue;

        if (!issue) {
            throw new Error("Failed to fetch created issue details.");
        }

        // Fetch all Linear users for the dropdown
        const usersResponse = await linearClient.users();
        const userOptions = usersResponse.nodes
            .filter(u => u.active)
            .map(u => ({
                text: { type: "plain_text" as const, text: u.name },
                value: JSON.stringify({ issueId: issue.id, userId: u.id })
            }))
            .slice(0, 100); // Slack limit

        // 5. Post Root Message
        const buildVersion = currentCycle
            ? (currentCycle.name || `V.1.0.${currentCycle.number}`)
            : 'None';

        const rootMessage = await client.chat.postMessage({
            channel: command.channel_id,
            text: `${title} (${issue.identifier})`,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `<${issue.url}|*${title}*>`
                    }
                },
                {
                    type: "context",
                    elements: [
                        {
                            type: "mrkdwn",
                            text: `Issue: \`${issue.identifier}\``
                        }
                    ]
                },
                {
                    type: "section",
                    fields: [
                        {
                            type: "mrkdwn",
                            text: `*담당자:*\n${linearUser.name}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*빌드:*\n${buildVersion}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*상태:*\nTodo`
                        }
                    ]
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: "우선순위, 기한, 라벨 등을 설정하고 싶다면 👉"
                    },
                    accessory: {
                        type: "button",
                        text: {
                            type: "plain_text",
                            text: "리니어에서 확인하기 🚀",
                            emoji: true
                        },
                        url: issue.url,
                        action_id: "view_issue",
                        style: "primary"
                    }
                },
                {
                    type: "divider"
                },
                {
                    type: "header",
                    text: {
                        type: "plain_text",
                        text: "누가 해결할 이슈인가요?",
                        emoji: true
                    }
                },
                {
                    type: "actions",
                    elements: [
                        {
                            type: "button",
                            text: {
                                type: "plain_text",
                                text: "나에게 할당",
                                emoji: true
                            },
                            action_id: "assign_to_me_btn",
                            value: issue.id
                        },
                        {
                            type: "static_select",
                            placeholder: {
                                type: "plain_text",
                                text: "할당할 팀원 선택...",
                                emoji: true
                            },
                            options: userOptions,
                            action_id: "assign_to_user"
                        }
                    ]
                },
                {
                    type: "header",
                    text: {
                        type: "plain_text",
                        text: "이슈가 완료되었나요?",
                        emoji: true
                    }
                },
                {
                    type: "actions",
                    elements: [
                        {
                            type: "button",
                            text: {
                                type: "plain_text",
                                text: "처리완료",
                                emoji: true
                            },
                            action_id: "mark_done",
                            value: issue.id
                        }
                    ]
                }
            ]
        });

        if (!rootMessage.ts) throw new Error("Failed to get root message TS.");

        // Save Mapping
        ThreadMappingStore.set(issue.identifier, command.channel_id, rootMessage.ts);

        // 6. Post Threaded Actions Message
        const threadMessage = await client.chat.postMessage({
            channel: command.channel_id,
            thread_ts: rootMessage.ts,
            text: "관리 도구",
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: "*관리 도구가 여기로 이동했습니다.*"
                    }
                }
            ]
        });

        console.log(`[Debug] Post Thread Message Success: ${threadMessage.ts}`);

    } catch (error) {
        console.error(error);
        let errorMessage = (error as Error).message;

        if (errorMessage.includes("channel_not_found")) {
            errorMessage = "봇이 이 채널에 초대되지 않았습니다. 채널에서 `/invite @봇이름`을 입력하여 봇을 초대해 주세요!";
        }

        await respond({
            text: `❌ 오류가 발생했습니다: ${errorMessage}`,
            response_type: 'ephemeral'
        });
    }
});

// -------------------------------------------------------------
// Issue list helpers (state/tag grouping + optional assignee override)
// -------------------------------------------------------------
const tagPrefixRegex = /^\s*(\[[^\]]+\]\s*)+/;
const extractTitleTags = (title: string): string[] => {
    const prefix = title.match(tagPrefixRegex)?.[0];
    if (!prefix) return [];
    const tags: string[] = [];
    const re = /\[([^\]]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(prefix)) !== null) {
        const t = (m[1] || '').trim();
        if (t) tags.push(t);
    }
    return tags;
};

async function getSlackEmailByUserId(client: any, userId: string): Promise<string | null> {
    const slackUser = await client.users.info({ user: userId });
    return slackUser.user?.profile?.email || null;
}

async function resolveSlackUserIdFromToken(client: any, token: string): Promise<string | null> {
    const raw = (token || '').trim();
    // allow tokens like "@jun," or "<@U123>,"
    const cleaned = raw.replace(/[,:;]+$/g, '');

    // Preferred: Slack mention token like <@U123ABC> or <@U123ABC|name>
    const mention = cleaned.match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>$/);
    if (mention) return mention[1];

    // Best-effort: plain @name
    const at = cleaned.match(/^@([\w.\-]+)$/);
    if (!at) return null;

    const handle = (at[1] || '').trim();
    const h = handle.toLowerCase();

    const norm = (s?: string) => (s || '').trim().toLowerCase();

    // NOTE: requires users:read. If not available, we'll just fail gracefully.
    try {
        let cursor: string | undefined = undefined;
        for (let i = 0; i < 5; i++) { // safety cap
            const res: any = await client.users.list({ limit: 200, cursor });
            const members = res.members || [];
            const match = members.find((m: any) => {
                if (m.deleted || m.is_bot) return false;
                const name = norm(m.name);
                const dn = norm(m.profile?.display_name);
                const dnn = norm(m.profile?.display_name_normalized);
                const rn = norm(m.profile?.real_name);
                const rnn = norm(m.profile?.real_name_normalized);
                return name === h || dn === h || dnn === h || rn === h || rnn === h;
            });
            if (match?.id) return match.id;
            cursor = res.response_metadata?.next_cursor;
            if (!cursor) break;
        }
    } catch (e) {
        console.warn("Failed to list users (missing users:read scope?)", e);
    }

    return null;
}

async function fetchActiveIssuesByAssigneeId(assigneeId: string) {
    return linearClient.issues({
        filter: {
            assignee: { id: { eq: assigneeId } },
            state: { type: { nin: ['completed', 'canceled'] } }
        }
    });
}

type IssueRow = { issue: any; assigneeName: string; tags: string[]; stateName: string };

async function buildIssueRows(issues: any[]): Promise<IssueRow[]> {
    const rows: IssueRow[] = [];
    for (const issue of issues) {
        const assignee = await issue.assignee;
        const state = await issue.state;
        rows.push({
            issue,
            assigneeName: assignee?.name || 'Unassigned',
            tags: extractTitleTags(issue.title || ''),
            stateName: state?.name || 'Unknown'
        });
    }
    return rows;
}

function groupRowsByState(rows: IssueRow[]) {
    const grouped: Record<string, IssueRow[]> = {};
    for (const r of rows) {
        const key = r.stateName;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(r);
    }
    return grouped;
}

function groupRowsByTags(rows: IssueRow[], requestedTag?: string) {
    const grouped: Record<string, IssueRow[]> = {};

    for (const r of rows) {
        const tags = r.tags;
        if (tags.length === 0) {
            const key = 'NoTag';
            if (!requestedTag || requestedTag === key) {
                if (!grouped[key]) grouped[key] = [];
                grouped[key].push(r);
            }
            continue;
        }

        // duplicate inclusion for all tags
        for (const t of tags) {
            if (requestedTag && requestedTag !== t) continue;
            if (!grouped[t]) grouped[t] = [];
            grouped[t].push(r);
        }
    }

    return grouped;
}

function sortGroupKeys(grouped: Record<string, any[]>) {
    return Object.keys(grouped).sort((a, b) => {
        const diff = (grouped[b]?.length || 0) - (grouped[a]?.length || 0);
        if (diff !== 0) return diff;
        return a.localeCompare(b);
    });
}

async function postGroupedListToThread(params: {
    client: any;
    channelId: string;
    requesterId: string;
    assigneeSlackIds: string[];
    mode: 'state' | 'tag';
    requestedTag?: string;
    grouped: Record<string, IssueRow[]>;
    totalIssues: number;
}) {
    const { client, channelId, requesterId, assigneeSlackIds, mode, requestedTag, grouped, totalIssues } = params;

    const groupKeys = sortGroupKeys(grouped);

    const assigneesText = (assigneeSlackIds && assigneeSlackIds.length > 0)
        ? assigneeSlackIds.map(id => `<@${id}>`).join(', ')
        : `<@${requesterId}>`;

    const header = mode === 'tag'
        ? (requestedTag
            ? `🔖 *<@${requesterId}>님 요청: ${assigneesText}의 태그별 활성 이슈 목록* (필터: \`${requestedTag}\`)`
            : `🔖 *<@${requesterId}>님 요청: ${assigneesText}의 태그별 활성 이슈 목록*`)
        : `🔍 *<@${requesterId}>님 요청: ${assigneesText}의 상태별 활성 이슈 목록*`;

    const rootMessage = await client.chat.postMessage({
        channel: channelId,
        text: mode === 'tag' ? '태그별 이슈 목록' : '상태별 이슈 목록',
        blocks: [
            {
                type: 'section',
                text: { type: 'mrkdwn', text: header }
            },
            {
                type: 'context',
                elements: [
                    {
                        type: 'mrkdwn',
                        text: `총 ${totalIssues}개의 이슈를 조회했습니다. (그룹 ${groupKeys.length}개) 자세한 내용은 스레드를 확인해주세요! 👇`
                    }
                ]
            }
        ]
    });

    if (!rootMessage.ts) throw new Error('Failed to post root message.');

    const threadBlocks: any[] = [];
    for (const key of groupKeys) {
        const rows = grouped[key] || [];
        threadBlocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: mode === 'tag' ? `*📂 [${key}] (${rows.length})*` : `*📂 ${key} (${rows.length})*` }
        });

        const lines = rows.map(r => `• <${r.issue.url}|${r.issue.title}>  —  *${r.assigneeName}*`);
        threadBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
        threadBlocks.push({ type: 'divider' });
    }

    await client.chat.postMessage({
        channel: channelId,
        thread_ts: rootMessage.ts,
        text: mode === 'tag' ? '태그별 이슈 리스트' : '상태별 이슈 리스트',
        blocks: threadBlocks
    });
}

// -------------------------------------------------------------
// Slack Command Handler: /이슈목록
// - 기본: 상태별 그룹
// - /이슈목록 태그 [TagName]: 태그별 그룹(+필터)
// - /이슈목록 @jun,@sean : 복수 assignee 지원(권장: 멘션 선택)
// - 조합: /이슈목록 @jun,@sean 태그 [TagName]
// -------------------------------------------------------------
app.command('/이슈목록', async ({ command, ack, respond, client }) => {
    return handleIssueListCommand({ command, ack, respond, client });
});

// (removed duplicate /태그목록 wrapper)

async function handleIssueListCommand({ command, ack, respond, client, modeOverride }: any) {
    await ack();

    try {
        const raw = (command.text || '').trim();
        const tokens = raw ? raw.split(/\s+/) : [];

        let mode: 'state' | 'tag' = modeOverride || 'state';
        let requestedTag: string | undefined;

        const assigneeTokens: string[] = [];

        // token parse
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];

            if (t === '태그' || t.toLowerCase() === 'tag') {
                mode = 'tag';
                const next = tokens[i + 1];
                if (next && !next.startsWith('@') && !next.startsWith('<@')) {
                    requestedTag = next;
                }
                continue;
            }

            // assignee token candidates: @jun or <@U123> possibly comma-separated
            if (t.startsWith('@') || t.startsWith('<@')) {
                const parts = t.split(',').map((s: string) => s.trim()).filter(Boolean);
                for (const p of parts) {
                    if (p.startsWith('@') || p.startsWith('<@')) assigneeTokens.push(p);
                }
            }
        }

        // resolve slack user ids
        const assigneeSlackIds: string[] = [];
        if (assigneeTokens.length > 0) {
            for (const tok of assigneeTokens) {
                const id = await resolveSlackUserIdFromToken(client, tok);
                if (id && !assigneeSlackIds.includes(id)) assigneeSlackIds.push(id);
            }

            // If user explicitly specified assignee(s) but none could be resolved,
            // do NOT silently fall back to requester.
            if (assigneeSlackIds.length === 0) {
                await respond({
                    text: `❌ 지정한 사용자(${assigneeTokens.join(', ')})를 Slack에서 찾지 못했어요.\n가능하면 슬랙에서 사용자 자동완성으로 멘션을 선택해서 <@U...> 형태로 입력해줘. 예: /이슈목록 <@U12345>\n(또는 봇에 users:read 권한이 없으면 @handle 매칭이 실패할 수 있어요.)`,
                    response_type: 'ephemeral'
                });
                return;
            }
        }

        if (assigneeSlackIds.length === 0) {
            assigneeSlackIds.push(command.user_id);
        }

        // fetch issues for each assignee
        const allIssues: any[] = [];
        const failedAssignees: string[] = [];

        for (const slackId of assigneeSlackIds) {
            const email = await getSlackEmailByUserId(client, slackId);
            if (!email) {
                failedAssignees.push(`<@${slackId}>`);
                continue;
            }

            const linearUser = await getLinearUserByEmail(email);
            if (!linearUser) {
                failedAssignees.push(`<@${slackId}>`);
                continue;
            }

            const issuesRes = await fetchActiveIssuesByAssigneeId(linearUser.id);
            const issues = issuesRes.nodes || [];
            allIssues.push(...issues);
        }

        if (allIssues.length === 0) {
            const who = assigneeSlackIds.map(id => `<@${id}>`).join(', ');
            await respond({
                text: `✅ ${who}에게 할당된 진행 중 이슈가 없습니다.`,
                response_type: 'in_channel'
            });
            return;
        }

        if (failedAssignees.length > 0) {
            // best-effort warning (ephemeral)
            await respond({
                text: `⚠️ 일부 사용자는 매칭에 실패했어요: ${failedAssignees.join(', ')}\n가능하면 슬랙에서 멘션 자동완성으로 선택(<@U...>)해서 다시 시도해줘.`,
                response_type: 'ephemeral'
            });
        }

        const rows = await buildIssueRows(allIssues);

        if (mode === 'tag') {
            const grouped = groupRowsByTags(rows, requestedTag);
            const keys = Object.keys(grouped);
            if (keys.length === 0) {
                await respond({ text: `✅ 태그 "${requestedTag}"에 해당하는 진행 중 이슈가 없습니다.`, response_type: 'in_channel' });
                return;
            }
            await postGroupedListToThread({
                client,
                channelId: command.channel_id,
                requesterId: command.user_id,
                assigneeSlackIds,
                mode,
                requestedTag,
                grouped,
                totalIssues: allIssues.length
            });
            return;
        }

        const grouped = groupRowsByState(rows);
        await postGroupedListToThread({
            client,
            channelId: command.channel_id,
            requesterId: command.user_id,
            assigneeSlackIds,
            mode,
            grouped,
            totalIssues: allIssues.length
        });

    } catch (error) {
        console.error(error);
        let msg = (error as Error).message || String(error);

        // Common Slack error when bot isn't in the channel where the slash command was used
        if (msg.includes('channel_not_found')) {
            msg = "봇이 이 채널에 초대되지 않았습니다. 채널에서 `/invite @봇이름`(Lenaer)로 초대한 뒤 다시 시도해주세요.";
        }

        await respond({ text: `❌ 오류가 발생했습니다: ${msg}`, response_type: 'ephemeral' });
    }
}

// /태그목록은 위 helper를 사용
app.command('/태그목록', async ({ command, ack, respond, client }) => {
    // Ensure modeOverride=tag, and allow optional @user + tag filter
    return handleIssueListCommand({ command, ack, respond, client, modeOverride: 'tag' });
});

// Action Handler: 나에게 할당 버튼 (Assign to me - Button)
app.action('assign_to_me_btn', async ({ action, ack, body, client }) => {
    await ack();
    if (action.type !== 'button' || !action.value) return;

    try {
        const issueId = action.value;
        const slackUser = await client.users.info({ user: body.user.id });
        const userEmail = slackUser.user?.profile?.email;

        if (!userEmail) throw new Error("Slack email not found.");

        const linearUser = await getLinearUserByEmail(userEmail);
        if (!linearUser) throw new Error("Linear user not found.");

        await linearClient.updateIssue(issueId, { assigneeId: linearUser.id });

        const threadTs = (body as any).message?.thread_ts;
        const channelId = (body as any).channel?.id;

        if (threadTs && channelId) {
            const history = await client.conversations.replies({
                channel: channelId,
                ts: threadTs,
                latest: threadTs,
                limit: 1,
                inclusive: true
            });

            const rootMessage = history.messages?.[0];
            if (rootMessage && rootMessage.blocks) {
                const updatedBlocks = [...(rootMessage.blocks as any[])];
                if (updatedBlocks[1] && updatedBlocks[1].fields) {
                    updatedBlocks[1].fields[0].text = `*담당자:*\n${linearUser.name}`;
                }

                await client.chat.update({
                    channel: channelId,
                    ts: threadTs,
                    blocks: updatedBlocks as any,
                    text: `✅ 담당자가 변경되었습니다: ${linearUser.name}`
                });
            }
        }
    } catch (error) {
        console.error(error);
    }
});

// Action Handler: 팀원에게 할당 (Assign to user - Dropdown)
app.action('assign_to_user', async ({ action, ack, body, client }) => {
    await ack();
    if (action.type !== 'static_select' || !action.selected_option) return;

    try {
        const { issueId, userId } = JSON.parse(action.selected_option.value);
        const userName = action.selected_option.text.text;

        await linearClient.updateIssue(issueId, { assigneeId: userId });

        // Update the root message to show the new assignee
        // We need to find the root message TS which is the thread_ts of the current message
        const threadTs = (body as any).message?.thread_ts;
        const channelId = (body as any).channel?.id;

        if (threadTs && channelId) {
            // First, get the root message content
            const history = await client.conversations.replies({
                channel: channelId,
                ts: threadTs,
                latest: threadTs,
                limit: 1,
                inclusive: true
            });

            const rootMessage = history.messages?.[0];
            if (rootMessage && rootMessage.blocks) {
                const updatedBlocks = [...rootMessage.blocks];
                // 담당자 field is index 0
                if (updatedBlocks[1] && (updatedBlocks[1] as any).fields) {
                    (updatedBlocks[1] as any).fields[0].text = `*담당자:*\n${userName}`;
                }

                await client.chat.update({
                    channel: channelId,
                    ts: threadTs,
                    blocks: updatedBlocks as any,
                    text: `✅ 담당자가 변경되었습니다: ${userName}`
                });
            }
        }

    } catch (error) {
        console.error(error);
    }
});

// Action Handler: 처리 완료 (Mark as Done)
app.action('mark_done', async ({ action, ack, body, client }) => {
    await ack();
    if (action.type !== 'button' || !action.value) return;

    try {
        const issueId = action.value;
        const issue = await linearClient.issue(issueId);
        const team = await issue.team;

        if (!team) throw new Error("Team not found for issue.");

        const states = await linearClient.workflowStates({
            filter: {
                team: { id: { eq: team.id } },
                name: { in: ["Done", "Completed", "완료"] }
            }
        });

        const doneState = states.nodes[0] || (await linearClient.workflowStates({
            filter: { team: { id: { eq: team.id } }, type: { eq: 'completed' } }
        })).nodes[0];

        if (!doneState) throw new Error("Could not find a 'Done' state.");

        await linearClient.updateIssue(issueId, { stateId: doneState.id });

        // Update the Thread message (to remove the button)
        const threadBlocks: any = (body as any).message.blocks;
        // Mark done button is now at index 5 (0: View in Linear, 1: Divider, 2: Who header, 3: Assign actions, 4: Done header, 5: Done actions)
        if (threadBlocks[5] && threadBlocks[5].elements) {
            threadBlocks[5].elements = threadBlocks[5].elements.filter((el: any) => el.action_id !== 'mark_done');
        }

        const currentChannelId = (body as any).channel?.id;
        const currentMessageTs = (body as any).message?.ts;
        const threadTs = (body as any).message?.thread_ts;

        if (currentChannelId && currentMessageTs) {
            await client.chat.update({
                channel: currentChannelId,
                ts: currentMessageTs,
                blocks: threadBlocks,
                text: "✅ 이슈가 완료 처리되었습니다."
            });

            // Post a feedback message in thread
            await client.chat.postMessage({
                channel: currentChannelId,
                thread_ts: threadTs || currentMessageTs,
                text: `✅ <@${body.user.id}>님이 이 이슈를 완료 처리했습니다.`
            });
        }

        // Update the Root message (to change Status text)
        if (threadTs && currentChannelId) {
            const history = await client.conversations.replies({
                channel: currentChannelId,
                ts: threadTs,
                latest: threadTs,
                limit: 1,
                inclusive: true
            });

            const rootMessage = history.messages?.[0];
            if (rootMessage && rootMessage.blocks) {
                const updatedBlocks = [...(rootMessage.blocks as any[])];
                // 상태 field is index 2
                if (updatedBlocks[1] && updatedBlocks[1].fields) {
                    updatedBlocks[1].fields[2].text = `*상태:*\n${doneState.name}`;
                }

                await client.chat.update({
                    channel: currentChannelId,
                    ts: threadTs,
                    blocks: updatedBlocks as any,
                    text: `✅ 이슈 완료: ${doneState.name}`
                });
            }
        }

    } catch (error) {
        console.error(error);
    }
});



(async () => {
    const port = process.env.PORT || 3000;

    // Start Bolt App (Socket Mode)
    await app.start();
    console.log('⚡️ Slack Bolt app is running (Socket Mode)!');

    // Start Express Receiver (for Webhooks) - Use a wrapper to start it manually
    // Since we are using SocketMode, app.start() handles the WS connection.
    // But we need the http server for webhooks.
    await receiver.start(Number(port));
    console.log(`⚡️ Webhook Receiver is running on port ${port}!`);
})();

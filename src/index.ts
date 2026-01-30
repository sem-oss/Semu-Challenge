import { App, LogLevel, ExpressReceiver } from '@slack/bolt';
import { LinearClient } from '@linear/sdk';
import * as dotenv from 'dotenv';
import * as bodyParser from 'body-parser';

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

        // Extract Issue Identifier: e.g., "[1SW-123]"
        const match = rootMessage.text.match(/\[([A-Z0-9]+-\d+)\]/);
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
        // Strategy: Search for the Issue Identifier in Slack
        const searchResult = await app.client.search.messages({
            query: `"${issueIdentifier}"`, // Quote for exact phrase
            sort: 'timestamp',
            sort_dir: 'desc',
            count: 1
        });

        const match = searchResult.messages?.matches?.[0];
        if (!match) {
            console.log(`[Sync] Could not find Slack thread for ${issueIdentifier}`);
            return;
        }

        const channelId = match.channel?.id;
        const threadTs = match.ts;

        if (channelId && threadTs) {
            await app.client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: messageText
            });
            console.log(`[Sync] Updated Slack thread for ${issueIdentifier}`);
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
            text: `[${issue.identifier}] ${title}`,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `<${issue.url}|*[${issue.identifier}] ${title}*>`
                    }
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

        console.log(`[Debug] Post Root Message Success: ${rootMessage.ts}`);

        if (!rootMessage.ts) throw new Error("Failed to get root message TS.");

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

// Slack Command Handler: 이슈 목록 조회
app.command('/이슈목록', async ({ command, ack, respond, client }) => {
    await ack();

    try {
        const slackUser = await client.users.info({ user: command.user_id });
        const userEmail = slackUser.user?.profile?.email;

        if (!userEmail) {
            await respond({ text: "❌ Slack 프로필에서 이메일을 찾을 수 없습니다.", response_type: 'ephemeral' });
            return;
        }

        const linearUser = await getLinearUserByEmail(userEmail);
        if (!linearUser) {
            await respond({ text: "❌ Linear에서 사용자를 찾을 수 없습니다.", response_type: 'ephemeral' });
            return;
        }

        const issues = await linearClient.issues({
            filter: {
                assignee: { id: { eq: linearUser.id } },
                state: { type: { nin: ['completed', 'canceled'] } }
            }
        });

        if (issues.nodes.length === 0) {
            await respond({ text: "✅ 현재 나에게 할당된 진행 중인 이슈가 없습니다.", response_type: 'in_channel' });
            return;
        }

        const groupedIssues: Record<string, any[]> = {};
        for (const issue of issues.nodes) {
            const state = await issue.state;
            const stateName = state?.name || 'Unknown';
            if (!groupedIssues[stateName]) groupedIssues[stateName] = [];
            groupedIssues[stateName].push(issue);
        }

        const rootMessage = await client.chat.postMessage({
            channel: command.channel_id,
            text: `🔍 <@${command.user_id}>님의 이슈 목록을 조회했습니다.`,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `🔍 *<@${command.user_id}>님께 할당된 활성 이슈 목록*`
                    }
                },
                {
                    type: "context",
                    elements: [
                        {
                            type: "mrkdwn",
                            text: `총 ${issues.nodes.length}개의 이슈가 있습니다. 자세한 내용은 스레드를 확인해주세요! 👇`
                        }
                    ]
                }
            ]
        });

        if (!rootMessage.ts) throw new Error("Failed to post root message.");

        const threadBlocks: any[] = [];
        for (const [stateName, stateIssues] of Object.entries(groupedIssues)) {
            threadBlocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*📂 ${stateName} (${stateIssues.length})*`
                }
            });

            const issueLinks = stateIssues.map(i => `• <${i.url}|[${i.identifier}] ${i.title}>`).join('\n');
            threadBlocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: issueLinks
                }
            });
            threadBlocks.push({ type: "divider" });
        }

        await client.chat.postMessage({
            channel: command.channel_id,
            thread_ts: rootMessage.ts,
            text: "상세 이슈 리스트",
            blocks: threadBlocks
        });

    } catch (error) {
        console.error(error);
        await respond({ text: `❌ 오류가 발생했습니다: ${(error as Error).message}`, response_type: 'ephemeral' });
    }
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

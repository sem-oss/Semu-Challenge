import { App, LogLevel } from '@slack/bolt';
import { LinearClient } from '@linear/sdk';
import * as dotenv from 'dotenv';

dotenv.config();

// Initialize Linear Client
const linearClient = new LinearClient({
    apiKey: process.env.LINEAR_API_KEY,
});

// Initialize Slack Bolt App
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

// Slack Command Handler
app.command('/이슈!', async ({ command, ack, respond, client }) => {
    console.log(`[Debug] Command received: ${command.command} with text: ${command.text}`);
    await ack();

    const title = command.text.trim();
    if (!title) {
        await respond({
            text: "❌ 제목을 입력해주세요. 예: `/이슈생성 로그인 버그 수정`",
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
            // Fallback: Create unassigned if user not found, or error?
            // Let's warn the user but proceed unassigned? Or error?
            // Requirement says "ticket defaults to created by assignee" so we probably need the user.
            // Let's assume we need the user.
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

        // We need to find the "Todo" state or rely on default. 
        // Usually creating without stateId puts it in the default state (Todo/Backlog).
        // Requirement says "to do 티켓 디폴트로 생성".
        // We can fetch states for the team to be safe, but default is usually cleaner if configured in Linear.
        // Let's stick to default behavior first.

        const issueCreate = await linearClient.createIssue(issuePayload);
        const issue = await issueCreate.issue;

        if (!issue) {
            throw new Error("Failed to fetch created issue details.");
        }

        // 5. Respond
        const buildVersion = currentCycle
            ? (currentCycle.name || `V.1.0.${currentCycle.number}`)
            : 'None';

        await respond({
            response_type: 'in_channel',
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `✅ *새로운 이슈가 생성되었습니다!*`
                    }
                },
                {
                    type: "section",
                    fields: [
                        {
                            type: "mrkdwn",
                            text: `*제목:*\n${title}`
                        },
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
                    type: "actions",
                    elements: [
                        {
                            type: "button",
                            text: {
                                type: "plain_text",
                                text: "리니어에서 확인하기 🚀",
                                emoji: true
                            },
                            url: issue.url,
                            action_id: "view_issue",
                            style: "primary"
                        },
                        {
                            type: "button",
                            text: {
                                type: "plain_text",
                                text: "나에게 할당 👤",
                                emoji: true
                            },
                            action_id: "assign_to_me",
                            value: issue.id
                        },
                        {
                            type: "button",
                            text: {
                                type: "plain_text",
                                text: "처리 완료 ✅",
                                emoji: true
                            },
                            action_id: "mark_done",
                            value: issue.id
                        }
                    ]
                }
            ]
        });

    } catch (error) {
        console.error(error);
        await respond({
            text: `❌ 오류가 발생했습니다: ${(error as Error).message}`,
            response_type: 'ephemeral'
        });
    }
});

// Action Handler: 나에게 할당 (Assign to me)
app.action('assign_to_me', async ({ action, ack, body, client }) => {
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

        // Update original message to show new assignee
        const originalBlocks: any = (body as any).message.blocks;
        if (originalBlocks[1] && originalBlocks[1].fields) {
            originalBlocks[1].fields[1].text = `*담당자:*\n${linearUser.name}`;
        }

        const channelId = (body as any).channel?.id;
        const messageTs = (body as any).message?.ts;

        if (channelId && messageTs) {
            await client.chat.update({
                channel: channelId,
                ts: messageTs,
                blocks: originalBlocks,
                text: "✅ 담당자가 변경되었습니다."
            });
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

        // Update original message to show status change
        const originalBlocks: any = (body as any).message.blocks;
        if (originalBlocks[1] && originalBlocks[1].fields) {
            originalBlocks[1].fields[3].text = `*상태:*\n${doneState.name}`;
        }

        // Remove 'Mark as Done' button since it's already done
        if (originalBlocks[2] && originalBlocks[2].elements) {
            originalBlocks[2].elements = originalBlocks[2].elements.filter((el: any) => el.action_id !== 'mark_done');
        }

        const channelId = (body as any).channel?.id;
        const messageTs = (body as any).message?.ts;

        if (channelId && messageTs) {
            await client.chat.update({
                channel: channelId,
                ts: messageTs,
                blocks: originalBlocks,
                text: "✅ 이슈가 완료 처리되었습니다."
            });
        }
    } catch (error) {
        console.error(error);
    }
});

(async () => {
    await app.start(process.env.PORT || 3000);
    console.log('⚡️ Slack Bolt app is running!');
})();

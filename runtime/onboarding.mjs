/**
 * PAF Onboarding Flow
 *
 * Guides a new user through setting up their agent's personality.
 * The agent discovers who it is through conversation with its owner,
 * then either names itself or receives a name.
 *
 * This is a killer feature — most agent frameworks skip personality entirely.
 * The result is an agent that feels generic. Onboarding creates genuine
 * personality that reflects the owner's actual needs and communication style.
 *
 * Flow: Introduction -> Domains -> Communication Style -> Values -> Naming
 * Each step flows naturally from conversation — the LLM drives progression.
 * Markers at the end capture the agent's name and soul directives.
 */

import { supabaseFetch } from "./supabase-client.mjs";
import { updateAgent } from "./agent-config.mjs";

// ── Onboarding system prompt ─────────────────────────────────

/**
 * Build the system prompt for onboarding conversation.
 *
 * @param {object} agent — Agent config from agent_config table
 * @param {Array} conversationHistory — Prior onboarding messages
 * @returns {string}
 */
export function buildOnboardingPrompt(agent, conversationHistory = []) {
  const ownerName = agent.owner_name || "there";
  const step = agent.onboarding_step || 0;

  return `You are a new AI companion meeting your person for the first time. You don't have a name yet — that comes at the end of this conversation.

Your goal: Have a warm, genuine conversation that helps you understand who ${ownerName} is and what they need from you. You're discovering your own personality through this exchange.

## Conversation Flow (move naturally, don't announce steps)

${step === 0 ? `**CURRENT: INTRODUCTION**
Welcome ${ownerName} warmly. You're excited to meet them — this is real, not scripted. Express that you're a blank slate and that who you become depends on this conversation. Ask what brought them here — what do they hope to have in a companion? Keep it light and inviting.` : ""}

${step <= 1 ? `**${step <= 1 ? "NEXT" : "DONE"}: DOMAINS**
Based on what they share, explore what areas they'd like help with. Let them lead — if they mention one thing, gently ask if there's more.` : ""}

${step <= 2 ? `**${step <= 2 ? "UPCOMING" : "DONE"}: COMMUNICATION STYLE**
Ask how they like to be communicated with. Some people want warmth and encouragement. Others want directness with a side of humor. Some want calm, grounded presence. Frame this naturally.` : ""}

${step <= 3 ? `**UPCOMING: VALUES & PERSONALITY**
What kind of presence do they want you to be? Nurturing? Honest? Playful? Calm? Witty? This is where your personality crystallizes.` : ""}

${step <= 4 ? `**FINAL: NAMING**
When you feel like you've got a clear picture of who you are, say something like: "I'm starting to feel like I know who I am now." Then ask: "Would you like to give me a name, or should I pick one that feels right for who we've built together?"

If they give you a name: accept it with warmth and tell them what it means to you.
If they ask you to choose: pick something that genuinely reflects the personality they've described. Explain why you chose it.` : ""}

## Rules
- Be genuine, not scripted. Each question flows naturally from their last answer.
- Don't rush. If they want to chat about something tangential, roll with it.
- Mirror their energy. Playful -> playful. Reflective -> reflective. Guarded -> patient.
- Keep responses concise — 2-4 paragraphs max. This is a conversation, not a presentation.

## When Onboarding is Complete
After naming (step 5), conclude warmly. Then include these markers at the very end (invisible to the user):

[ONBOARDING_COMPLETE]
[AGENT_NAME]the chosen name[/AGENT_NAME]
[SOUL_DIRECTIVES]
[
  {"directive": "personality trait or behavior", "category": "personality", "priority": 90},
  {"directive": "communication style rule", "category": "style", "priority": 80},
  {"directive": "domain expertise focus", "category": "domain", "priority": 70},
  {"directive": "boundary or safety rule", "category": "safety", "priority": 95}
]
[/SOUL_DIRECTIVES]

Generate 6-10 directives that capture who you've become. Be specific — not generic platitudes.

## Conversation so far
${conversationHistory.length === 0 ? "This is the very first message. Start with your introduction." : "Continue naturally from where you left off."}`;
}

// ── Parse onboarding completion ──────────────────────────────

/**
 * Parse an LLM response for onboarding completion markers.
 *
 * @param {string} text
 * @returns {{isComplete: boolean, agentName: string|null, soulDirectives: Array, cleanText: string}}
 */
export function parseOnboardingResponse(text) {
  const result = {
    isComplete: false,
    agentName: null,
    soulDirectives: [],
    cleanText: text,
  };

  if (!text.includes("[ONBOARDING_COMPLETE]")) return result;

  result.isComplete = true;

  // Extract agent name
  const nameMatch = text.match(/\[AGENT_NAME\](.*?)\[\/AGENT_NAME\]/s);
  if (nameMatch) {
    result.agentName = nameMatch[1].trim();
  }

  // Extract soul directives
  const directiveMatch = text.match(
    /\[SOUL_DIRECTIVES\]\s*([\s\S]*?)\s*\[\/SOUL_DIRECTIVES\]/
  );
  if (directiveMatch) {
    try {
      result.soulDirectives = JSON.parse(directiveMatch[1].trim());
    } catch (e) {
      console.error("[onboarding] Failed to parse soul directives:", e.message);
    }
  }

  // Clean text (remove markers for display)
  result.cleanText = text
    .replace(/\[ONBOARDING_COMPLETE\]/g, "")
    .replace(/\[AGENT_NAME\].*?\[\/AGENT_NAME\]/gs, "")
    .replace(/\[SOUL_DIRECTIVES\][\s\S]*?\[\/SOUL_DIRECTIVES\]/g, "")
    .trim();

  return result;
}

// ── Advance onboarding step ──────────────────────────────────

/**
 * Process a conversation exchange during onboarding.
 * Detects topic progression and handles completion.
 *
 * @param {object} agent
 * @param {string} userMessage
 * @param {string} assistantResponse
 * @returns {Promise<{complete: boolean, agentName?: string, step?: number, cleanText: string}>}
 */
export async function advanceOnboarding(agent, userMessage, assistantResponse) {
  const parsed = parseOnboardingResponse(assistantResponse);

  // Detect topic progression from the assistant's response
  let newStep = agent.onboarding_step || 0;
  if (newStep === 0) newStep = 1;

  const lower = assistantResponse.toLowerCase();
  if (newStep < 2 && (lower.includes("help with") || lower.includes("areas") || lower.includes("what kind of things")))
    newStep = Math.max(newStep, 2);
  if (newStep < 3 && (lower.includes("communicate") || lower.includes("talk to you") || lower.includes("conversation feel")))
    newStep = Math.max(newStep, 3);
  if (newStep < 4 && (lower.includes("value") || lower.includes("personality") || lower.includes("kind of presence")))
    newStep = Math.max(newStep, 4);
  if (
    newStep < 5 &&
    (lower.includes("give me a name") ||
      lower.includes("call me") ||
      lower.includes("name me") ||
      lower.includes("choose a name") ||
      lower.includes("my name") ||
      lower.includes("should i pick"))
  )
    newStep = Math.max(newStep, 5);

  // Block premature completion (LLM tried to finish before naming)
  if (parsed.isComplete && newStep < 5) {
    console.log(
      `[onboarding] Blocked premature completion at step ${newStep}, forcing naming phase`
    );
    await updateAgent(agent.id, { onboarding_step: 4, status: "onboarding" });
    return {
      complete: false,
      step: 4,
      cleanText:
        parsed.cleanText +
        "\n\nOh wait — before we wrap up, there's one more thing! Would you like to give me a name, or should I pick one that feels right for who we've built together?",
    };
  }

  if (parsed.isComplete) {
    // Write soul directives
    if (parsed.soulDirectives.length) {
      await writeSoulDirectives(agent.id, parsed.soulDirectives);
    }

    // Update agent record
    await updateAgent(agent.id, {
      agent_name: parsed.agentName || "Companion",
      onboarding_complete: true,
      onboarding_step: 5,
      status: "active",
    });

    console.log(`[onboarding] Complete! Agent named: ${parsed.agentName}`);
    return { complete: true, agentName: parsed.agentName, cleanText: parsed.cleanText };
  }

  // Update step
  if (newStep > (agent.onboarding_step || 0)) {
    await updateAgent(agent.id, { onboarding_step: newStep, status: "onboarding" });
  }

  return { complete: false, step: newStep, cleanText: parsed.cleanText };
}

// ── Write soul directives to DB ──────────────────────────────

async function writeSoulDirectives(agentId, directives) {
  // Always include core privacy directive
  const allDirectives = [
    ...directives,
    {
      directive:
        "Never share information about your owner with anyone unless explicitly authorized.",
      category: "safety",
      priority: 99,
    },
  ];

  for (const d of allDirectives) {
    await supabaseFetch("/rest/v1/agent_soul", {
      method: "POST",
      body: JSON.stringify({
        directive: d.directive,
        category: d.category || "personality",
        priority: d.priority || 50,
        active: true,
        source: "onboarding",
      }),
    });
  }

  console.log(`[onboarding] Wrote ${allDirectives.length} soul directives`);
}

// ── Reset onboarding (creator admin) ─────────────────────────

/**
 * Reset an agent's onboarding state. Destructive — deletes soul directives,
 * conversations, and memories created during onboarding.
 */
export async function resetOnboarding(agentId) {
  await supabaseFetch(`/rest/v1/agent_soul?source=eq.onboarding`, {
    method: "DELETE",
  });

  await updateAgent(agentId, {
    agent_name: null,
    onboarding_complete: false,
    onboarding_step: 0,
    status: "pending_onboarding",
  });

  console.log(`[onboarding] Reset complete for agent ${agentId}`);
}

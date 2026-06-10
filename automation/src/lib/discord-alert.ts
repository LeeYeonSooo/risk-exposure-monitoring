import { env } from "@/config/chains";

/**
 * Discord 알람 — 미식별 주소·큰 변경·watchlist 갱신 등 운영 알림.
 * Discord 웹훅은 `{ content }` 또는 `{ embeds:[…] }` 를 받는다(Slack blocks 와 다름).
 * DISCORD_WEBHOOK_URL 미설정이면 stub 로그만(zero-cost 기본).
 */
export async function postDiscord(message: {
  title: string;
  body?: string;
  fields?: Array<{ k: string; v: string }>;
}): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) {
    console.log(`[discord-stub] ${message.title}${message.body ? ": " + message.body : ""}`);
    return;
  }

  const embed: Record<string, unknown> = { title: message.title.slice(0, 256) };
  if (message.body) embed.description = message.body.slice(0, 4096);
  if (message.fields && message.fields.length > 0) {
    embed.fields = message.fields.slice(0, 25).map((f) => ({
      name: (f.k || "—").slice(0, 256),
      value: (f.v || "—").slice(0, 1024),
      inline: true,
    }));
  }

  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  }).catch((e) => console.warn("Discord post failed:", e));
}

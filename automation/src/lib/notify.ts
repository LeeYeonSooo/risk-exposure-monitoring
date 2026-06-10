/**
 * 알림 채널 디스패치 (설계 D#9) — insertAlert 가 DB 적재 후 호출.
 *
 * 채널은 **env 가 설정됐을 때만** 발송(아니면 no-op → 기본 zero-cost, DB 가 source of truth).
 *   DISCORD_WEBHOOK_URL · TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID · ALERT_WEBHOOK_URL(범용 JSON POST).
 * info 는 DB 만(채널 발송 안 함 — 노이즈 컷). warning/critical 만 발송.
 * 발송 실패는 삼켜서(알림이 메인 파이프라인을 막지 않게) 경고만 — fire-and-forget 권장.
 */
import { env } from "@/config/chains";

export interface AlertNotice {
  severity: string;
  kind: string;
  token: string;
  message: string;
  source?: string;
}

const SEV_EMOJI: Record<string, string> = { critical: "🔴", warning: "🟠", info: "🔵" };

function formatText(a: AlertNotice): string {
  const tag = SEV_EMOJI[a.severity] ?? "⚪";
  return `${tag} [${a.severity.toUpperCase()}] ${a.token} · ${a.kind}\n${a.message}${a.source ? `\n— ${a.source}` : ""}`;
}

async function postJson(url: string, body: unknown, label: string): Promise<void> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) console.warn(`[notify] ${label} ${r.status}`);
  } catch (e) {
    console.warn(`[notify] ${label} 실패:`, (e as Error).message);
  }
}

/** 설정된 모든 채널로 알림 발송. info 는 skip. env 없으면 no-op. */
export async function dispatchAlert(a: AlertNotice): Promise<void> {
  if (a.severity === "info") return; // info = DB only
  const text = formatText(a);
  const jobs: Promise<void>[] = [];
  if (env.DISCORD_WEBHOOK_URL) jobs.push(postJson(env.DISCORD_WEBHOOK_URL, { content: text }, "discord")); // Discord 웹훅 본문 = { content }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(postJson(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: env.TELEGRAM_CHAT_ID, text }, "telegram"));
  }
  if (env.ALERT_WEBHOOK_URL) jobs.push(postJson(env.ALERT_WEBHOOK_URL, { ...a, text }, "webhook"));
  if (jobs.length) await Promise.all(jobs);
}

/** 어떤 채널이 활성인지(기동 로그용). */
export function activeChannels(): string[] {
  const c: string[] = [];
  if (env.DISCORD_WEBHOOK_URL) c.push("discord");
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) c.push("telegram");
  if (env.ALERT_WEBHOOK_URL) c.push("webhook");
  return c;
}

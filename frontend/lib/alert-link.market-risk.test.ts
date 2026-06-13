// 회귀: 알림 → 관계맵 노드 위험색의 "마켓 단위" 조인 (회장 작업1, 5/6 1순위 블로커).
//   핵심 보장:
//    (1) 마켓-식별 알림(detail.loanAsset+lltv)은 같은 프로토콜이라도 그 마켓 노드(_market.loan+lltv 일치)에만 위험색.
//    (2) 동일 프로토콜의 비매칭 마켓은 안전색 유지(의사결정 변별력 복원).
//    (3) 매칭된 마켓의 큐레이터 볼트 노드(id=`{mktId}:v{k}`)도 같이 위험(자금추적 노출 전파).
//    (4) 마켓-식별 불가 알림(loanAsset/lltv 없는 utilization 류)만 프로토콜 슬러그 폴백 보존.
//    (5) 결정론: 같은 입력 → 같은 출력.
import { describe, it, expect } from "vitest";
import { mapAlertsToNodeRisk, type RiskAlertLike, type RiskNodeLike } from "./alert-link";

const mkt = (loan: string, lltv: number, coll: string, loanA: string): RiskNodeLike => ({
  id: `legomkt:morpho_blue:${coll}-${loanA}@ethereum`,
  metadata: { venue: "morpho_blue", _market: { loan, lltv, kind: "lending" } },
});
const vaultOf = (m: RiskNodeLike, k: number): RiskNodeLike => ({ id: `${m.id}:v${k}`, metadata: { venue: "morpho_blue" } });

describe("mapAlertsToNodeRisk — 마켓 단위 조인", () => {
  it("마켓-식별 알림은 일치 마켓 + 그 볼트만 위험, 비매칭 동일프로토콜 마켓은 안전", () => {
    const alerts: RiskAlertLike[] = [
      { severity: "warning", kind: "bad_debt_threshold", protocol_node_id: "protocol:morpho_blue", detail: { lltv: 0.915, loanAsset: "USDtb", debtUsd: 108e6 } },
    ];
    const hit = mkt("USDtb", 0.915, "0x1", "0xa");
    const miss1 = mkt("USDC", 0.915, "0x2", "0xb");
    const miss2 = mkt("PYUSD", 0.915, "0x3", "0xc");
    const hitVault = vaultOf(hit, 0);
    const r = mapAlertsToNodeRisk(alerts, [hit, miss1, miss2, hitVault]);
    expect(r.get(hit.id)).toBe("caution");
    expect(r.get(hitVault.id)).toBe("caution"); // 볼트 전파
    expect(r.get(miss1.id)).toBeUndefined();     // 비매칭 → 안전
    expect(r.get(miss2.id)).toBeUndefined();
  });

  it("critical → danger 가 caution 보다 우선(같은 마켓에 두 알림)", () => {
    const alerts: RiskAlertLike[] = [
      { severity: "warning", protocol_node_id: "protocol:morpho_blue", detail: { lltv: 0.965, loanAsset: "USDT" } },
      { severity: "critical", protocol_node_id: "protocol:morpho_blue", detail: { lltv: 0.965, loanAsset: "USDT" } },
    ];
    const m = mkt("USDT", 0.965, "0x1", "0xa");
    expect(mapAlertsToNodeRisk(alerts, [m]).get(m.id)).toBe("danger");
  });

  it("LLTV 표기차(퍼센트/wei/소수)를 결정론적으로 흡수", () => {
    const m = mkt("USDT", 0.915, "0x1", "0xa");
    for (const lltv of [0.915, 91.5, "915000000000000000"]) {
      const r = mapAlertsToNodeRisk(
        [{ severity: "critical", protocol_node_id: "protocol:morpho_blue", detail: { lltv, loanAsset: "USDT" } }],
        [m],
      );
      expect(r.get(m.id)).toBe("danger");
    }
  });

  it("마켓-식별 불가 알림(loanAsset/lltv 없음)은 프로토콜 슬러그 폴백", () => {
    const alerts: RiskAlertLike[] = [
      { severity: "warning", kind: "high_utilization", protocol_node_id: "protocol:euler_v2", detail: { chain: "plasma", market: "euler-v2", utilization: 1 } },
    ];
    // euler 마켓 노드(_market 에 lltv 없음 → 마켓키 없음) + euler 프로토콜 허브
    const eulerMkt: RiskNodeLike = { id: "legomkt:euler_v2:0xe-0xf@ethereum", metadata: { venue: "euler_v2", _market: { loan: "USDC", kind: "lending" } } };
    const eulerHub: RiskNodeLike = { id: "c:ethereum:dl:euler-v2", metadata: { brandSlug: "euler-v2" } };
    const r = mapAlertsToNodeRisk(alerts, [eulerMkt, eulerHub]);
    expect(r.get(eulerMkt.id)).toBe("caution"); // 폴백 적용
    expect(r.get(eulerHub.id)).toBe("caution");
  });

  it("마켓-식별 가능 노드는 슬러그 폴백을 받지 않는다(특정 마켓 미매칭이면 안전 유지)", () => {
    // 마켓-식별 알림(morpho USDtb)과 마켓-식별 불가 알림(morpho utilization, 같은 프로토콜) 공존.
    const alerts: RiskAlertLike[] = [
      { severity: "critical", protocol_node_id: "protocol:morpho_blue", detail: { lltv: 0.915, loanAsset: "USDtb" } },
      { severity: "warning", protocol_node_id: "protocol:morpho_blue", detail: { utilization: 0.99 } }, // 마켓키 없음 → 슬러그 폴백
    ];
    const hit = mkt("USDtb", 0.915, "0x1", "0xa");   // 마켓 일치 → danger
    const other = mkt("USDC", 0.86, "0x2", "0xb");   // 마켓-식별 가능하나 알림과 불일치 → 폴백 안 받고 안전
    const r = mapAlertsToNodeRisk(alerts, [hit, other]);
    expect(r.get(hit.id)).toBe("danger");
    expect(r.get(other.id)).toBeUndefined();
  });

  it("결정론: 같은 입력 두 번 호출 → 동일 출력", () => {
    const alerts: RiskAlertLike[] = [{ severity: "critical", protocol_node_id: "protocol:morpho_blue", detail: { lltv: 0.915, loanAsset: "USDT" } }];
    const nodes = [mkt("USDT", 0.915, "0x1", "0xa"), mkt("USDC", 0.915, "0x2", "0xb")];
    const a = [...mapAlertsToNodeRisk(alerts, nodes).entries()].sort();
    const b = [...mapAlertsToNodeRisk(alerts, nodes).entries()].sort();
    expect(a).toEqual(b);
  });
});

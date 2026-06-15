# chain_supply_spike — FP 검증 (✅ 2026-06-12)

활성 2건 → **TP 0 / FP 2 / UNCERTAIN 0**.

- **#111 GHO@base** +10,005 (z=699.2): **Σ 전체인 공급 오히려 −190k** → arbitrum(−200k)→base(+10k) **브릿지 재분배**, 신규 mint 아님. flat-MAD z폭발(baseline MAD=9.65). z 재현 699.18 일치.
- **#110 DAI@gnosis** +39,511 (z=7.3): relΔ=**0.053%**(minRelDelta 0.5% 미달), Σ 전체인 +0.016%(평탄), xDAI(WXDAI $0.9998) 브릿지 양방향 노이즈. z 재현 7.34 일치.

## 근본원인
`automation/scripts/snapshot-chain-supply.ts:133` 발화식이 `diff.ts checkTotalSupply`(L492–502)의 3대 억제 — **`minRelDelta`(0.5%)·`autoMintWhitelist`·`designedRebase`** — 를 이식 안 함 + **체인별 z만 보고 Σ전체인 공급 불변(브릿지 이동)을 미검사**. (GHO·DAI 둘 다 autoMintWhitelist 대상인데 무시됨.)

## 1순위 수정안 (미적용)
`snapshot-chain-supply.ts:133`에:
1. `relDelta >= TS.minRelDelta` + whitelist `minAbs×100` 게이트 이식 (DAI건 즉시 제거, GHO micro-noise 차단)
2. **Σ전체인 공급이 실제 증가했을 때만 발화**(`sumGrew`) — OR 체인 단일 ≥`singleTxPctBps`(5%) 게이트로 micro-chain 진짜 mint 보완
- 부작용 없음: diff.ts가 메인넷에 쓰는 검증된 값. 진짜 Kelp식 무단민팅은 Σ 폭증이라 그대로 잡힘.

근거: DB `chain_supply_samples` z 재현 + Σ합산 · `/api/breadth` · DefiLlama. 코드: `snapshot-chain-supply.ts:133` · `diff.ts:492-502`.

> supply_spike와 동일 계열 FP. **공통 수정**: 통계 z 경로(diff.ts·chain-supply 양쪽)의 MAD-floor/minRelDelta/whitelist 일원화.

import type { Address } from "viem";

import { makeAaveV3FamilyAdapter } from "./aave-v3-family";

// Spark = Aave V3 직접 포크. 동일 팩토리로 풀 risk params (PAP 온체인 확인됨).
export const sparkAdapter = makeAaveV3FamilyAdapter({
  family: "spark",
  nodeId: "protocol:spark",
  label: "Spark",
  poolAddressesProvider: "0x02C3eA4e34C0cBd694D2adFa2c690EECbC1793eE" as Address,
  pool: "0xc13e21b648a5ee794902342038ff3adab66be987" as Address,
  architecture: "mono_pool_aave_fork",
  governance: "Sky/Spark DAO",
  oracleProvider: "Chainlink (Spark oracle)",
});

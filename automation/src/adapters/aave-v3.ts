import type { Address } from "viem";

import { makeAaveV3FamilyAdapter } from "./aave-v3-family";

// Aave V3 mainnet — PoolAddressesProvider 에서 DataProvider/Oracle 동적 조회.
export const aaveV3Adapter = makeAaveV3FamilyAdapter({
  family: "aave_v3",
  nodeId: "protocol:aave_v3",
  label: "Aave V3",
  poolAddressesProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e" as Address,
  pool: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2" as Address,
  architecture: "mono_pool",
  governance: "Aave DAO",
  oracleProvider: "Chainlink composite (with CAPO)",
});

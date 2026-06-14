import { defineConfig } from "vitest/config";
import path from "node:path";

// tsconfig 의 "@/*": ["./*"] 경로 별칭을 vitest 에도 반영 (테스트가 @/lib/... 임포트를 풀 수 있게).
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});

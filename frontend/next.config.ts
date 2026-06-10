import type { NextConfig } from "next";

// 모든 /api/* 는 이 앱의 App Router 라우트가 처리:
//   /api/topology/[token]  → automation Postgres 의 최신 스냅샷
//   /api/alerts            → diff 알림
//   /api/portfolio         → 지갑 익스포저
// (구 Python 백엔드 :8000 프록시는 제거됨)
const nextConfig: NextConfig = {};

export default nextConfig;

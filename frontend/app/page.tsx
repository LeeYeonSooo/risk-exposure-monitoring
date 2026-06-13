import { redirect } from "next/navigation";

// 흐름맵 단독 배포 — 루트는 /flow 로 보낸다(랜딩/검색 페이지 제거됨). 2026-06-13.
export default function Home() {
  redirect("/flow");
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Exposure Intelligence",
  description: "토큰 중심 DeFi 익스포저·리스크 인텔리전스 — 어떤 토큰이 어디에 얼마나 노출됐는지 매핑하고 위험 변화를 알림",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

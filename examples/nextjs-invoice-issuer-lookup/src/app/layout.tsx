import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "インボイス登録事業者を検索",
  description: "T番号から登録事業者情報を取得するNext.jsサンプル",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className={geistSans.variable}>
      <body>{children}</body>
    </html>
  );
}

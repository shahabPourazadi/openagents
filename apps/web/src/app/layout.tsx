import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AccountGate } from "@/components/account-gate";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AccountStatusProvider } from "@/lib/account-status";
import { AuthProvider } from "@/lib/auth-context";
import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "OpenAgents — self-hostable open agent workspace by YVR Studio",
  description:
    "Self-hostable open agent workspace powered by specialized Agents. By YVR Studio.",
  icons: {
    icon: [{ url: "/brand/oa-icon.webp", type: "image/webp" }],
    apple: [{ url: "/brand/oa-icon.webp", type: "image/webp" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full flex flex-col font-sans" suppressHydrationWarning>
        <AuthProvider>
          <AccountStatusProvider>
            <AccountGate>
              <TooltipProvider>{children}</TooltipProvider>
            </AccountGate>
          </AccountStatusProvider>
        </AuthProvider>
      </body>
    </html>
  );
}

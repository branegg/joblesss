import type { Metadata } from "next";
import { Instrument_Sans } from "next/font/google";
import Link from "next/link";
import { connection } from "next/server";
import { NavLink } from "@/components/nav-link";
import { getDb } from "@/db";
import { pendingFindings } from "@/lib/inbox/inbox";
import { isEndStage } from "@/lib/stages";
import { dueApplications, listApplications } from "@/lib/tracker";
import { readVault } from "@/lib/vault/entries";
import "./globals.css";

const body = Instrument_Sans({ variable: "--font-body", subsets: ["latin", "latin-ext"] });

export const metadata: Metadata = {
  title: "Joblesss",
  description: "My private job search and career record",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();
  const db = getDb();
  const drafts = readVault().entries.filter((entry) => entry.status === "draft").length;
  const due = dueApplications(db).length;
  const emails = pendingFindings(db).length;
  const open = listApplications(db).filter((application) => !isEndStage(application.stage)).length;
  return (
    <html lang="en" className={`${body.variable} antialiased`}>
      <body>
        <div className="shell">
          <aside className="rail">
            <div className="rail-inner">
              <Link href="/" className="brand">Joblesss</Link>
              <nav aria-label="Main">
                <div className="nav-group">
                  <NavLink href="/">Overview</NavLink>
                  <NavLink href="/applications">
                    Applications
                    {due > 0 ? <span className="count" aria-label={`${due} next steps due`}>{due}</span> : open > 0 && <span className="nav-total">{open}</span>}
                  </NavLink>
                  <NavLink href="/stand">Where things stand</NavLink>
                  <NavLink href="/jobs">Jobs</NavLink>
                  <NavLink href="/email">
                    Email
                    {emails > 0 && <span className="count" aria-label={`${emails} email updates waiting`}>{emails}</span>}
                  </NavLink>
                </div>
                <div className="nav-group">
                  <p className="nav-label">Your record</p>
                  <NavLink href="/wiki">My profile</NavLink>
                  <NavLink href="/review">
                    Review drafts
                    {drafts > 0 && <span className="count" aria-label={`${drafts} drafts waiting`}>{drafts}</span>}
                  </NavLink>
                  <NavLink href="/contact">Contact details</NavLink>
                </div>
                <div className="nav-group">
                  <p className="nav-label">Behind the scenes</p>
                  <NavLink href="/runs">Agent activity</NavLink>
                  <NavLink href="/job-sources">Job sources</NavLink>
                </div>
              </nav>
            </div>
          </aside>
          <main className="page">{children}</main>
        </div>
      </body>
    </html>
  );
}

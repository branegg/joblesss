import Link from "next/link";
import { connection } from "next/server";
import { CallControl } from "@/components/call-control";
import { getDb } from "@/db";
import { formatCallTime } from "@/lib/calls";
import { formatAgo } from "@/lib/format";
import { standRows, type StandRow } from "@/lib/stand";

export const metadata = { title: "Where things stand" };

function noReply(sentAt: Date, now: Date): string {
  const ago = formatAgo(sentAt, now);
  if (ago === "today") return "no reply yet";
  if (ago === "yesterday") return "no reply, 1 day";
  return `no reply, ${ago.replace(/ ago$/, "")}`;
}

function CallCell({ row }: { row: StandRow }) {
  if (!row.call) return <span className="muted">—</span>;
  if (row.call.booked) return <span className="call-booked">Booked · {formatCallTime(row.call.at)}</span>;
  const day = row.call.at.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return (
    <span>
      Had · {day}
      {row.waitingToHear && <span className="muted"> · waiting to hear</span>}
    </span>
  );
}

export default async function StandPage() {
  await connection();
  const now = new Date();
  const rows = standRows(getDb(), now);
  const closed = rows.filter((row) => row.closed).length;
  return (
    <>
      <header className="page-head">
        <h1>Where things stand</h1>
        <p className="lede">{rows.length === 0 ? "Nothing sent yet. Applications show up here once you've applied." : `${rows.length - closed} open, ${closed} closed. Booked calls first, then whoever has been quiet longest.`}</p>
      </header>
      {rows.length > 0 && (
        <div className="tally-wrap">
          <table className="tally stand">
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col" className="stand-role-col">Role</th>
                <th scope="col">Stage</th>
                <th scope="col">Call</th>
                <th scope="col">Last heard</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={row.closed ? "stand-closed" : undefined}>
                  <td><Link href={`/applications/${row.id}`} className="row-title">{row.company}</Link><div className="row-note stand-role-inline">{row.role}</div></td>
                  <td className="stand-role-col"><Link href={`/applications/${row.id}`} className="stand-role">{row.role}</Link></td>
                  <td>{row.stageLabel}</td>
                  <td>
                    <CallCell row={row} />
                    <CallControl key={row.call ? `${row.call.callId}-${row.call.at.getTime()}` : "new"} applicationId={row.id} call={row.call} />
                  </td>
                  <td>{row.lastHeard ? formatAgo(row.lastHeard, now) : <span className="muted">{noReply(row.sentAt, now)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

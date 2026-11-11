import { deleteCall, saveCall } from "@/app/stand/actions";

function toInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function CallControl({ applicationId, call }: { applicationId: number; call?: { callId: number; at: Date; booked: boolean } }) {
  const booked = call?.booked ? call : undefined;
  return (
    <details className="call-control">
      <summary>{booked ? "Change call" : "Add a call"}</summary>
      <form action={saveCall} className="call-form">
        <input type="hidden" name="applicationId" value={applicationId} />
        {booked && <input type="hidden" name="callId" value={booked.callId} />}
        <label className="field">
          <span>Call time</span>
          <input type="datetime-local" name="at" className="input" defaultValue={booked ? toInput(booked.at) : ""} required />
        </label>
        <button className="button">Save call</button>
      </form>
      {call && (
        <form action={deleteCall}>
          <input type="hidden" name="callId" value={call.callId} />
          <button className="button button-quiet">Remove call</button>
        </form>
      )}
    </details>
  );
}

"use client";

// Every schedule of the signed-in User: new conversations per run made here, and the follow-ups made from a
// conversation (its header's clock) or by the agent.
import { PageHeader } from "@/components/console/page-header";
import { ScheduleForm, ScheduleList } from "@/components/console/schedules";
import { ScrollArea } from "@/components/ui/scroll-area";

const SchedulesPage = () => (
  <div className="flex h-full min-h-0 flex-col">
    <title>Schedules · effect-pi</title>
    <PageHeader title="Schedules" />
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-6">
        <section aria-labelledby="new-schedule" className="flex flex-col gap-2">
          <h2 id="new-schedule" className="font-heading text-sm font-semibold">
            New conversation on a schedule
          </h2>
          <p className="text-muted-foreground text-xs">
            Each run opens a fresh conversation with this message. A run that
            finds the server full waits up to an hour for room, then counts as
            missed; one missed while the server was down runs once when it is
            back.
          </p>
          <ScheduleForm />
        </section>
        <section
          aria-labelledby="all-schedules"
          className="flex flex-col gap-2"
        >
          <h2 id="all-schedules" className="font-heading text-sm font-semibold">
            All schedules
          </h2>
          <ScheduleList />
        </section>
      </div>
    </ScrollArea>
  </div>
);

export default SchedulesPage;

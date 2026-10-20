"use client";

// Switches for a conversation's settings: its approval policy, extensions (with their tools) and skills. Used for
// the open conversation (each switch is saved at once) and for a new one (the switches go with the create).
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight, ShieldAlert } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import type { Settings } from "@/lib/settings";
import { cn } from "@/lib/utils";

export interface SettingsPanelProps {
  readonly settings: Settings;
  /** The approval policy's switch; omitted where it lives elsewhere (the new conversation form). */
  readonly approvals?: {
    readonly ask: boolean;
    readonly handleChange: (ask: boolean) => void;
  };
  readonly onExtension: (name: string, on: boolean) => void;
  readonly onTool: (name: string, on: boolean) => void;
  readonly onSkill: (name: string, on: boolean) => void;
  readonly disabled?: boolean;
}

const Row = ({
  label,
  hint,
  checked,
  disabled,
  onChange,
  mono = false,
}: {
  label: string;
  hint?: string | undefined;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
  mono?: boolean;
}) => (
  <div className="flex items-start gap-2">
    <Switch
      size="sm"
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      aria-label={label}
      className="mt-0.5"
    />
    <span className="flex min-w-0 flex-col">
      <span className={cn("text-sm", mono && "font-mono text-xs")}>
        {label}
      </span>
      {hint === undefined || hint === "" ? null : (
        <span className="text-muted-foreground text-xs leading-normal">
          {hint}
        </span>
      )}
    </span>
  </div>
);

const levelHint = (levels: boolean, locked: boolean): string | undefined => {
  if (locked) {
    return "Always on";
  }
  return levels ? undefined : "Needs a shell or desktop sandbox; upgrade first";
};

export const SettingsPanel = ({
  settings,
  approvals,
  onExtension,
  onTool,
  onSkill,
  disabled = false,
}: SettingsPanelProps) => (
  <div className="flex flex-col gap-4">
    {approvals === undefined ? null : (
      <Row
        label="Ask before running commands"
        hint="You approve each command, file change and desktop action. The agent also asks before upgrading to a shell or desktop sandbox."
        checked={approvals.ask}
        disabled={disabled}
        onChange={approvals.handleChange}
      />
    )}
    <div className="flex flex-col gap-2">
      <h4 className="text-muted-foreground text-xs font-medium">Extensions</h4>
      <ul className="flex flex-col gap-1">
        {settings.extensions.map((extension) => (
          <li key={extension.name}>
            <Collapsible.Root>
              <div className="flex items-start gap-1">
                <div className="min-w-0 flex-1">
                  <Row
                    label={extension.name}
                    hint={levelHint(extension.available, extension.locked)}
                    checked={extension.enabled}
                    disabled={
                      disabled ||
                      extension.locked ||
                      (!extension.available && !extension.enabled)
                    }
                    onChange={(on) => onExtension(extension.name, on)}
                  />
                </div>
                {extension.tools.length === 0 ? null : (
                  <Collapsible.Trigger
                    aria-label={`${extension.name} tools`}
                    className="hover:bg-muted focus-visible:ring-ring group text-muted-foreground flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs outline-none focus-visible:ring-2"
                  >
                    {extension.tools.filter((tool) => tool.enabled).length}/
                    {extension.tools.length} tools
                    <ChevronRight
                      aria-hidden
                      className="size-3.5 transition-transform duration-150 group-data-panel-open:rotate-90"
                      strokeWidth={1.5}
                    />
                  </Collapsible.Trigger>
                )}
              </div>
              <Collapsible.Panel>
                <ul className="flex flex-col gap-1.5 py-1.5 pl-9">
                  {extension.tools.map((tool) => (
                    <li key={tool.name}>
                      <Row
                        label={tool.name}
                        hint={
                          extension.enabled
                            ? tool.description
                            : "Off with its extension"
                        }
                        checked={tool.enabled && extension.enabled}
                        // A locked extension's tools stay on with it.
                        disabled={
                          disabled || !extension.enabled || extension.locked
                        }
                        onChange={(on) => onTool(tool.name, on)}
                        mono
                      />
                      {tool.approval ? (
                        <span className="text-warning ml-9 inline-flex items-center gap-0.5 text-xs">
                          <ShieldAlert
                            aria-hidden
                            className="size-3"
                            strokeWidth={1.5}
                          />
                          needs approval
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Collapsible.Panel>
            </Collapsible.Root>
          </li>
        ))}
      </ul>
    </div>
    {settings.skills.length === 0 ? null : (
      <div className="flex flex-col gap-2">
        <h4 className="text-muted-foreground text-xs font-medium">Skills</h4>
        <ul className="flex flex-col gap-1.5">
          {settings.skills.map((skill) => (
            <li key={skill.name}>
              <Row
                label={skill.name}
                hint={skill.description}
                checked={skill.enabled}
                disabled={disabled}
                onChange={(on) => onSkill(skill.name, on)}
              />
            </li>
          ))}
        </ul>
      </div>
    )}
  </div>
);

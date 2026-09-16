/**
 * Private OpenVPN tunnel.
 *
 * OpenVPN Connect has no per-app mode on Windows — connecting it routes the
 * whole PC. This dialog is the one place that explains that, picks a Connect
 * profile, and asks Keel to bring up an isolated copy instead.
 */

import {
  LoaderCircle,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { VpnState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useKeel } from "@/state/store";

type Tone = "connected" | "connecting" | "error" | "idle";

const TONE_COLOR: Record<Tone, string> = {
  connected: "var(--keel-done)",
  connecting: "var(--keel-working)",
  error: "var(--keel-dead)",
  idle: "var(--keel-text-faint)",
};

/** One reading of the tunnel state, shared by the dialog and the footer chip. */
export function vpnView(vpn: VpnState): {
  tone: Tone;
  color: string;
  headline: string;
} {
  const tone: Tone =
    vpn.phase === "connected"
      ? "connected"
      : vpn.phase === "connecting"
        ? "connecting"
        : vpn.phase === "error" || vpn.error
          ? "error"
          : "idle";
  const headline =
    tone === "connected"
      ? "Connected"
      : tone === "connecting"
        ? "Connecting…"
        : tone === "error"
          ? "Couldn't connect"
          : "Not connected";
  return { tone, color: TONE_COLOR[tone], headline };
}

export function VpnDialog() {
  const vpn = useKeel((state) => state.vpn);
  const { tone, color } = vpnView(vpn);
  const noProfiles = vpn.profiles.length === 0;
  const profileValue = vpn.profileId ?? vpn.profiles[0]?.id;
  const Icon =
    tone === "connected" ? ShieldCheck : tone === "error" ? ShieldAlert : ShieldOff;

  return (
    <Dialog
      open={vpn.dialogOpen}
      onOpenChange={(open) => {
        if (open) useKeel.getState().openVpnSettings();
        else useKeel.getState().closeVpnSettings();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-w-[440px] gap-0 overflow-hidden p-0 sm:max-w-[440px]"
      >
        <header className="flex items-start gap-3 px-5 pb-4 pt-5">
          <span
            className="grid size-9 shrink-0 place-items-center rounded-[10px] transition-colors"
            style={{
              color,
              background: `color-mix(in srgb, ${color} 14%, transparent)`,
              boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 24%, transparent)`,
            }}
          >
            <Icon className="size-[18px]" />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <DialogTitle className="text-[15px] font-semibold tracking-[-0.01em]">
              Private VPN
            </DialogTitle>
            <DialogDescription className="mt-1 text-[12px] leading-snug text-faint">
              Only Keel and its terminals use the tunnel. The rest of this PC
              stays on your normal connection.
            </DialogDescription>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => useKeel.getState().closeVpnSettings()}
            className="k-icon-btn -mr-1.5 -mt-1 size-7"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex flex-col gap-4 px-5 pb-5">
          <StatusCard vpn={vpn} />

          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-dim">Profile</span>
            <Select
              {...(profileValue ? { value: profileValue } : {})}
              onValueChange={(value) => useKeel.getState().setVpnProfile(value)}
              disabled={noProfiles}
            >
              <SelectTrigger aria-label="Profile">
                <SelectValue placeholder="No profiles found" />
              </SelectTrigger>
              <SelectContent>
                {vpn.profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {noProfiles ? (
              <span className="text-[12px] leading-snug text-faint">
                Import a profile in OpenVPN Connect first — Keel reads it from
                that app&apos;s profiles folder.
              </span>
            ) : null}
          </div>

          <SwitchRow
            checked={vpn.autoConnect}
            onChange={(checked) => useKeel.getState().setVpnAutoConnect(checked)}
            title="Connect on launch"
            hint="Bring the tunnel up before any terminal starts."
          />

          {!vpn.openvpnPath ? (
            <div
              className="flex gap-2.5 rounded-[var(--keel-r-control)] px-3 py-2.5"
              style={{
                background:
                  "color-mix(in srgb, var(--keel-ansi-yellow) 9%, transparent)",
                boxShadow:
                  "inset 0 0 0 1px color-mix(in srgb, var(--keel-ansi-yellow) 22%, transparent)",
              }}
            >
              <TriangleAlert
                className="mt-px size-4 shrink-0"
                style={{ color: "var(--keel-ansi-yellow)" }}
              />
              <p className="text-[12px] leading-relaxed text-dim">
                <span className="font-medium text-foreground">
                  OpenVPN client needed.
                </span>{" "}
                Connect can&apos;t isolate a single app. Install the OpenVPN
                community client (it ships{" "}
                <code className="font-mono text-[11px]">openvpn.exe</code>) so
                Keel can run a tunnel that leaves this PC alone.
              </p>
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line bg-veil px-5 py-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => useKeel.getState().closeVpnSettings()}
          >
            Done
          </Button>
          {vpn.phase === "connected" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const ok = window.confirm(
                  "Disconnect the private VPN? Keel terminals will use this PC's normal connection.",
                );
                if (!ok) return;
                void useKeel.getState().disconnectVpn();
              }}
            >
              Disconnect
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={vpn.phase === "connecting"}
              onClick={() => void useKeel.getState().connectVpn(vpn.profileId)}
            >
              {vpn.phase === "connecting" ? (
                <LoaderCircle className="animate-spin" />
              ) : null}
              {vpn.phase === "connecting"
                ? "Connecting"
                : tone === "error"
                  ? "Try again"
                  : "Connect"}
            </Button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function StatusCard({ vpn }: { vpn: VpnState }) {
  const { tone, color, headline } = vpnView(vpn);
  const detail =
    tone === "connected"
      ? (vpn.profileName ?? "Private tunnel")
      : tone === "connecting"
        ? "Bringing up a private tunnel…"
        : tone === "error"
          ? (vpn.error ?? "The tunnel stopped unexpectedly.")
          : "This PC is using your normal internet.";

  return (
    <div className="overflow-hidden rounded-[12px] border border-line bg-[color:var(--keel-void)]">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <StatusLight tone={tone} color={color} size={10} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">{headline}</p>
          <p
            className={cn(
              "mt-0.5 text-[12px] leading-snug",
              tone === "error"
                ? "max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-[color:var(--keel-dead)]"
                : "text-faint",
            )}
          >
            {detail}
          </p>
        </div>
        {tone === "connected" ? (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium leading-none"
            style={
              vpn.isolated
                ? {
                    color: "var(--keel-done)",
                    background:
                      "color-mix(in srgb, var(--keel-done) 12%, transparent)",
                  }
                : {
                    color: "var(--keel-ansi-yellow)",
                    background:
                      "color-mix(in srgb, var(--keel-ansi-yellow) 12%, transparent)",
                  }
            }
            title={
              vpn.isolated
                ? "The rest of this PC is not on the VPN"
                : "Isolation could not be verified"
            }
          >
            {vpn.isolated ? (
              <ShieldCheck className="size-3" />
            ) : (
              <ShieldAlert className="size-3" />
            )}
            {vpn.isolated ? "App only" : "Unverified"}
          </span>
        ) : null}
      </div>

      {tone === "connected" && (vpn.tunnelIp || vpn.proxyPort || vpn.adapter) ? (
        <dl className="grid grid-cols-3 divide-x divide-line border-t border-line">
          <Detail label="Tunnel IP" value={vpn.tunnelIp} mono />
          <Detail
            label="Proxy"
            value={vpn.proxyPort ? `:${vpn.proxyPort}` : null}
            mono
          />
          <Detail label="Adapter" value={vpn.adapter} />
        </dl>
      ) : null}
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 px-3.5 py-2.5">
      <dt className="text-[11px] text-faint">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 truncate text-foreground",
          mono ? "font-mono text-[12px]" : "text-[12px]",
        )}
        title={value ?? undefined}
      >
        {value ?? "—"}
      </dd>
    </div>
  );
}

/** A status dot with a soft halo; it breathes while the tunnel is coming up. */
export function StatusLight({
  tone,
  color,
  size = 8,
}: {
  tone: Tone;
  color: string;
  size?: number;
}) {
  return (
    <span
      aria-hidden
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      {tone === "connecting" ? (
        <span
          className="absolute inset-0 animate-ping rounded-full opacity-60"
          style={{ background: color }}
        />
      ) : null}
      <span
        className="relative rounded-full"
        style={{
          width: size,
          height: size,
          background: tone === "idle" ? "transparent" : color,
          boxShadow:
            tone === "idle"
              ? `inset 0 0 0 1.5px ${color}`
              : `0 0 0 ${Math.max(2, size / 3)}px color-mix(in srgb, ${color} 22%, transparent)`,
        }}
      />
    </span>
  );
}

function SwitchRow({
  checked,
  onChange,
  title,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-3 rounded-[var(--keel-r-control)] text-left outline-none"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-foreground">
          {title}
        </span>
        <span className="mt-0.5 block text-[12px] leading-snug text-faint">
          {hint}
        </span>
      </span>
      <span
        aria-hidden
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150",
          checked ? "bg-foreground" : "bg-veil-3",
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 top-0.5 size-4 rounded-full shadow-sm transition-transform duration-150",
            checked
              ? "translate-x-4 bg-[color:var(--keel-void)]"
              : "translate-x-0 bg-foreground/80",
          )}
        />
      </span>
    </button>
  );
}

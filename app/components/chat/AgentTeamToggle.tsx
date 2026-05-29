import { memo } from 'react';
import { UserGroupIcon } from '@heroicons/react/24/outline';
import { Button } from '@ui/Button';

/**
 * Small toolbar toggle that lets the user opt in to Agent Orchestrator team
 * mode without needing the LaunchDarkly flag. The choice is persisted by the
 * caller (localStorage) and OR-ed with the `enable-agent-team` flag server-side.
 */
export const AgentTeamToggle = memo(function AgentTeamToggle({
  enabled,
  setEnabled,
}: {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}) {
  return (
    <Button
      variant={enabled ? 'primary' : 'neutral'}
      size="xs"
      inline
      focused={enabled}
      onClick={() => setEnabled(!enabled)}
      icon={<UserGroupIcon className="size-4" />}
      aria-label={enabled ? 'Agent Team mode on' : 'Agent Team mode off'}
      tip={
        enabled
          ? 'Agent Team: ON — a coordinated team of specialized agents, overseen by a Team Head, will build your app. Click to turn off.'
          : 'Agent Team: OFF — click to build with a coordinated team of agents instead of a single agent.'
      }
    >
      Team
    </Button>
  );
});

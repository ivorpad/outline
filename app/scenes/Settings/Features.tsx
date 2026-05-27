import { observer } from "mobx-react";
import { CopyIcon, SparklesIcon } from "outline-icons";
import * as React from "react";
import { useTranslation, Trans } from "react-i18next";
import { toast } from "sonner";
import { TeamPreference } from "@shared/types";
import { TeamValidation } from "@shared/validations";
import Flex from "~/components/Flex";
import Heading from "~/components/Heading";
import Scene from "~/components/Scene";
import Switch from "~/components/Switch";
import Text from "~/components/Text";
import useCurrentTeam from "~/hooks/useCurrentTeam";
import SettingRow from "./components/SettingRow";
import Input from "~/components/Input";
import Tooltip from "~/components/Tooltip";
import CopyToClipboard from "~/components/CopyToClipboard";
import NudeButton from "~/components/NudeButton";
import { client } from "~/utils/ApiClient";
import styled, { useTheme } from "styled-components";

function Features() {
  const { t } = useTranslation();
  const team = useCurrentTeam();
  const theme = useTheme();

  const handleMCPChange = React.useCallback(
    async (checked: boolean) => {
      team.setPreference(TeamPreference.MCP, checked);
      await team.save();
      toast.success(t("Settings saved"));
    },
    [team, t]
  );

  const handleGuidanceMCPChange = React.useCallback(
    async (ev: React.ChangeEvent<HTMLTextAreaElement>) => {
      team.guidanceMCP = ev.target.value || null;
    },
    [team]
  );

  const handleGuidanceMCPBlur = React.useCallback(async () => {
    await team.save();
    toast.success(t("Settings saved"));
  }, [team, t]);

  const handleCopied = React.useCallback(() => {
    toast.success(t("Copied to clipboard"));
  }, [t]);

  const mcpEndpoint = window.location.origin + "/mcp";

  return (
    <Scene title={t("AI")} icon={<SparklesIcon />}>
      <Heading>{t("AI")}</Heading>
      <Text as="p" type="secondary">
        <Trans>Manage AI and integration features for your workspace.</Trans>
      </Text>

      <SettingRow
        name={TeamPreference.MCP}
        label={t("MCP server")}
        border={!team.getPreference(TeamPreference.MCP)}
        description={
          <>
            <Text type="secondary" as="p">
              {t(
                "Allow members to connect to this workspace with MCP to read and write data."
              )}
            </Text>
            {team.getPreference(TeamPreference.MCP) && (
              <>
                <Text
                  type="secondary"
                  as="p"
                  style={{ marginTop: 8, marginBottom: 4 }}
                >
                  <Trans
                    defaults="Use the following endpoint to connect to the MCP server from your app. Find out more about setup in <a>the docs</a>."
                    components={{
                      a: (
                        <Text
                          as="a"
                          weight="bold"
                          href="https://docs.getoutline.com/s/guide/doc/mcp-6j9jtENNKL"
                          target="_blank"
                          rel="noopener noreferrer"
                        />
                      ),
                    }}
                  />
                </Text>
                <Input readOnly value={mcpEndpoint}>
                  <Tooltip content={t("Copy URL")} placement="top">
                    <CopyToClipboard text={mcpEndpoint} onCopy={handleCopied}>
                      <NudeButton type="button" style={{ marginRight: 3 }}>
                        <CopyIcon color={theme.placeholder} size={18} />
                      </NudeButton>
                    </CopyToClipboard>
                  </Tooltip>
                </Input>
              </>
            )}
          </>
        }
      >
        <Switch
          id={TeamPreference.MCP}
          name={TeamPreference.MCP}
          checked={team.getPreference(TeamPreference.MCP)}
          onChange={handleMCPChange}
        />
      </SettingRow>

      {team.getPreference(TeamPreference.MCP) && (
        <SettingRow
          name="guidanceMCP"
          label={t("Additional guidance")}
          description={
            <>
              <div style={{ marginBottom: 8 }}>
                {t(
                  "You can use these optional instructions to tell MCP clients how to use your knowledge base."
                )}
              </div>
              <Input
                id="guidanceMCP"
                type="textarea"
                autoSize
                minHeight="6lh"
                maxHeight="20lh"
                value={team.guidanceMCP ?? ""}
                maxLength={TeamValidation.maxGuidanceMCPLength}
                warningLimit={TeamValidation.warnGuidanceMCPLength}
                onChange={handleGuidanceMCPChange}
                onBlur={handleGuidanceMCPBlur}
              />
            </>
          }
        />
      )}

      <SettingRow
        name="answers"
        label={t("AI answers")}
        description={t(
          "Index this workspace's documents and use AI to answer questions in search. Powered by LiteLLM + VectorAI on this fork."
        )}
        border={false}
      >
        <ReindexButton />
      </SettingRow>
    </Scene>
  );
}

type AiStatus = {
  enabled: boolean;
  total: number;
  indexed: number;
  pending: number;
};

const ProgressTrack = styled.div`
  width: 240px;
  height: 6px;
  border-radius: 3px;
  background: ${(props) => props.theme.divider};
  overflow: hidden;
`;

const ProgressBar = styled.div`
  height: 100%;
  background: ${(props) => props.theme.accent};
  transition: width 300ms ease;
`;

function ReindexButton() {
  const { t } = useTranslation();
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState<AiStatus | null>(null);

  const fetchStatus = React.useCallback(async () => {
    try {
      const data = (await client.post("/aiAnswers.status", {})) as AiStatus;
      setStatus(data);
      return data;
    } catch {
      return null;
    }
  }, []);

  React.useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  React.useEffect(() => {
    if (!status?.pending) {
      return;
    }
    const id = setInterval(() => {
      void fetchStatus();
    }, 4000);
    return () => clearInterval(id);
  }, [status?.pending, fetchStatus]);

  const trigger = React.useCallback(
    async (force: boolean) => {
      setBusy(true);
      try {
        const data = (await client.post("/aiAnswers.reindex", { force })) as {
          queued?: number;
          skipped?: number;
          total?: number;
        };
        const skipped = data.skipped ?? 0;
        toast.success(
          skipped > 0 && !force
            ? t(
                "Queued {{queued}} docs (skipped {{skipped}} already up-to-date)",
                { queued: data.queued ?? 0, skipped }
              )
            : t("Queued {{count}} documents for indexing", {
                count: data.queued ?? 0,
              })
        );
        void fetchStatus();
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [t, fetchStatus]
  );

  const pct =
    status && status.total > 0
      ? Math.round((status.indexed / status.total) * 100)
      : 0;

  return (
    <Flex column gap={6}>
      <Flex gap={8} align="center">
        <NudeButton
          onClick={() => trigger(false)}
          disabled={busy}
          width="auto"
          height="auto"
        >
          <Text type="secondary">
            {busy ? t("Indexing…") : t("Re-index changed")}
          </Text>
        </NudeButton>
        <NudeButton
          onClick={() => trigger(true)}
          disabled={busy}
          width="auto"
          height="auto"
        >
          <Text type="tertiary" size="small">
            {t("Force all")}
          </Text>
        </NudeButton>
      </Flex>
      {status && (
        <Flex column gap={2}>
          <Text type="tertiary" size="small">
            {t("Indexed")}: {status.indexed} / {status.total} ({pct}%)
            {status.pending > 0 ? ` · ${status.pending} pending` : ""}
          </Text>
          <ProgressTrack>
            <ProgressBar style={{ width: `${pct}%` }} />
          </ProgressTrack>
        </Flex>
      )}
    </Flex>
  );
}

export default observer(Features);

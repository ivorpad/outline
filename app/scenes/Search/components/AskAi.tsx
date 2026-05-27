import { SparklesIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import styled from "styled-components";
import { s } from "@shared/styles";
import Flex from "~/components/Flex";
import Text from "~/components/Text";
import { client } from "~/utils/ApiClient";

type Citation = {
  documentId: string;
  title: string;
  url: string;
  text: string;
  score: number;
};

type AnswerPayload = {
  answer: string | null;
  citations: Citation[];
  error?: string;
};

type Props = { query: string };

function AskAi({ query }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = React.useState(false);
  const [data, setData] = React.useState<AnswerPayload | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!query) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    client
      .post("/aiAnswers.ask", { query })
      .then((res) => {
        if (!cancelled) {
          setData(res as AnswerPayload);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setErr(e.message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  if (!query || (!loading && !data && !err)) {
    return null;
  }

  return (
    <Card column>
      <Header align="center" gap={8}>
        <SparklesIcon size={18} />
        <Text weight="bold">{t("AI answer")}</Text>
        {loading && (
          <Text type="secondary" size="small">
            {t("Thinking…")}
          </Text>
        )}
      </Header>
      {err && (
        <Text type="danger" size="small">
          {err}
        </Text>
      )}
      {data?.answer && <AnswerBody>{data.answer}</AnswerBody>}
      {data && !data.answer && !loading && (
        <Text type="secondary" size="small">
          {t("No answer could be generated from your documents.")}
        </Text>
      )}
      {data?.citations && data.citations.length > 0 && (
        <Citations column gap={4}>
          <Text type="secondary" size="xsmall">
            {t("Sources")}
          </Text>
          {data.citations.slice(0, 6).map((c, i) => (
            <CiteLink key={`${c.documentId}-${i}`} to={c.url || "#"}>
              <Text size="small" weight="bold">
                [{i + 1}] {c.title || t("Untitled")}
              </Text>
              <Text size="xsmall" type="secondary">
                {c.text.slice(0, 160)}
                {c.text.length > 160 ? "…" : ""}
              </Text>
            </CiteLink>
          ))}
        </Citations>
      )}
    </Card>
  );
}

const Card = styled(Flex)`
  margin: 0 0 16px;
  padding: 12px 14px;
  border: 1px solid ${s("divider")};
  border-radius: 8px;
  background: ${s("backgroundSecondary")};
  gap: 8px;
`;

const Header = styled(Flex)`
  color: ${s("text")};
`;

const AnswerBody = styled.div`
  color: ${s("text")};
  font-size: 15px;
  line-height: 1.5;
  white-space: pre-wrap;
`;

const Citations = styled(Flex)`
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px dashed ${s("divider")};
`;

const CiteLink = styled(Link)`
  display: block;
  padding: 4px 6px;
  border-radius: 4px;
  color: inherit;
  text-decoration: none;
  &:hover {
    background: ${s("listItemHoverBackground")};
  }
`;

export default AskAi;

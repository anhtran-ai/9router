import TokenExchangeClient from "../TokenExchangeClient";

export default async function ContributorTokenPage({ params }) {
  const { token } = await params;
  return <TokenExchangeClient token={token} />;
}

import { useAuth } from '../context/AuthContext';
import WaCampaigns from '../components/WaCampaigns';

/** «حملات واتساب» — صفحة اشتراك (wa_campaigns) يفعّلها السوبر أدمن لموظفي المكتب. */
export default function WaCampaignsPage() {
  const { token } = useAuth();
  return <WaCampaigns base="/api/wa-campaigns" token={token} />;
}

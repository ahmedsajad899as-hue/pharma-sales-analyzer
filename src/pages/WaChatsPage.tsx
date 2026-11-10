import { useAuth } from '../context/AuthContext';
import WaChats from '../components/WaChats';

/** «محادثات واتساب» — صفحة اشتراك (wa_chats) يفعّلها السوبر أدمن لكل حساب. */
export default function WaChatsPage() {
  const { token } = useAuth();
  return <div className="wd-page"><WaChats base="/api/warehouse-dispatch" token={token} /></div>;
}

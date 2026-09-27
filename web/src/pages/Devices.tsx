import { AddDevice } from '../components/AddDevice';
import { PageHeader } from '../components/ui';

export default function Devices() {
  return (
    <div className="animate-rise">
      <PageHeader title="Add a device" subtitle="Your laptop, your parents’ computers, everyone’s phones — all connected to the same orders." />
      <AddDevice />
    </div>
  );
}

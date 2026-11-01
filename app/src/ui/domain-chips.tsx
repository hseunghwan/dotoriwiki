import { ScrollView, View } from 'react-native';
import { useApp } from '../state';
import { Chip } from './parts';
import { copy } from '../text';

/** Auto plus each domain. `null` is auto: the gateway's classifier decides. */
export function DomainChips({ value, onChange, wrap }: { value: string | null; onChange: (d: string | null) => void; wrap?: boolean }) {
  const domains = useApp((a) => a.domains);
  const chips = [
    <Chip key="auto" label={copy.common.auto} on={value === null} onPress={() => onChange(null)} />,
    ...domains.map((d) => <Chip key={d} label={d} on={value === d} onPress={() => onChange(d)} />),
  ];
  if (wrap) return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{chips}</View>;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
      {chips}
    </ScrollView>
  );
}

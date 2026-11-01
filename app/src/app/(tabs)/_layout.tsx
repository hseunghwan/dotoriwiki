import { Redirect, Tabs } from 'expo-router';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state';
import { Icon, type IconName } from '../../ui/icon';
import { useTheme } from '../../ui/theme';
import { copy } from '../../text';

const TABS: Record<string, { label: string; icon: IconName }> = {
  index: { label: copy.tabs.index, icon: 'pencil' },
  chat: { label: copy.tabs.chat, icon: 'chat' },
  activity: { label: copy.tabs.activity, icon: 'history' },
};

function BottomNav({ state, navigateToTab }: BottomTabBarProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', height: 64 + insets.bottom, paddingBottom: insets.bottom, borderTopWidth: 1, borderTopColor: t.line, backgroundColor: t.bg }}>
      {state.routes.map((route, i) => {
        const tab = TABS[route.name];
        if (!tab) return null;
        const on = state.index === i;
        const color = on ? t.fg : t.faint;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => navigateToTab(route.key)}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 }}
          >
            <Icon name={tab.icon} size={22} color={color} />
            <Text style={{ color, fontSize: 11, fontWeight: '500' }}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function TabsLayout() {
  const paired = useApp((a) => a.pairing !== null);
  if (!paired) return <Redirect href="/onboarding" />;
  return (
    <Tabs tabBar={(props) => <BottomNav {...props} />} screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="chat" />
      <Tabs.Screen name="activity" />
    </Tabs>
  );
}

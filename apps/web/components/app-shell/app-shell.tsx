"use client";

// The three navigation layouts, switchable in Settings -> Navigation layout (stored in this browser):
//   compact -> one sticky row: home link, section pills, actions (sections collapse into a menu when out of room)
//   center  -> one row: home link, centered segmented sections, actions; compact under 1200px viewport width
//   side    -> left sidebar: home link, actions, sections with icons; compact under 1000px viewport width
// The saved layout is on <html data-layout> before first paint (LAYOUT_BOOT_SCRIPT) and globals.css shows exactly one
// of the chrome blocks below (data-chrome) from it plus the viewport width, so nothing is decided by JS after mount.
import { type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Box, Container, Flex, Grid, HStack, Menu, Portal, Stack, Text } from "@chakra-ui/react";
import { CommandIcon, MenuIcon, SettingsIcon } from "lucide-react";
import { JarvisNavActions, JarvisVoiceActivity } from "@/app/todo/todo-jarvis";
import { CompactNavActions, NavAction } from "@/components/shared/nav-action";
import { LayoutPreferenceProvider } from "./layout-preference";
import { SWAP_TRANSITION, TopBarSlotOutlet, TopBarSlotProvider, useTopBarSlotShown } from "./top-bar-slot";
import { isActivePath, SECTIONS, SETTINGS_HREF } from "./sections";

// Focus spaces (To-Do) take the whole window: no app navigation. The space renders its own "Back to Quantself" link.
const FOCUS_SPACES = ["/todo"];
export const isFocusSpace = (pathname: string | null) => !!pathname && FOCUS_SPACES.some((root) => pathname === root || pathname.startsWith(`${root}/`));

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isFocusSpace(pathname)) return (
    <LayoutPreferenceProvider>
      <Box data-shell data-focus-space minH="100dvh" w="full">
        {children}
        <JarvisVoiceActivity />
      </Box>
    </LayoutPreferenceProvider>
  );
  return (
    <LayoutPreferenceProvider>
      <TopBarSlotProvider>
        <Flex data-shell>
          <div data-chrome="side"><SideBar /></div>
          <Box flex="1" minW="0">
            <div data-chrome="compact"><TopBar variant="compact" /></div>
            <div data-chrome="center"><TopBar variant="center" /></div>
            <TopBarSlotOutlet />
            {children}
            <JarvisVoiceActivity />
          </Box>
        </Flex>
      </TopBarSlotProvider>
    </LayoutPreferenceProvider>
  );
}

function HomeLink() {
  return (
    <Link href="/" aria-label="Quantself home">
      <HStack gap="2" h="9" flexShrink={0} color="fg">
        <CommandIcon size={20} aria-hidden="true" />
        <Text textStyle="md" fontWeight="semibold" letterSpacing="tight">Quantself</Text>
      </HStack>
    </Link>
  );
}

function SettingsAction({ fullWidth = false }: { fullWidth?: boolean }) {
  const pathname = usePathname();
  const on = isActivePath(pathname, SETTINGS_HREF);
  return (
    <NavAction asChild {...(fullWidth ? { w: "full", justifyContent: "flex-start" } : {})} bg={on ? "bg.muted" : "transparent"} color={on ? "fg" : "fg.muted"}>
      <Link href={SETTINGS_HREF} aria-current={on ? "page" : undefined}><SettingsIcon />Settings</Link>
    </NavAction>
  );
}

function SectionMenu() {
  const pathname = usePathname();
  return (
    <Menu.Root lazyMount unmountOnExit positioning={{ placement: "bottom-start" }}>
      <Menu.Trigger asChild><NavAction w="9" minW="9" h="9" px="0" aria-label="Sections menu"><MenuIcon /></NavAction></Menu.Trigger>
      <Portal><Menu.Positioner><Menu.Content>
        {SECTIONS.map(({ href, icon: Icon, label }) => (
          <Menu.Item key={href} value={href} asChild>
            <Link href={href} aria-current={isActivePath(pathname, href) ? "page" : undefined}><Icon size={16} aria-hidden="true" />{label}</Link>
          </Menu.Item>
        ))}
      </Menu.Content></Menu.Positioner></Portal>
    </Menu.Root>
  );
}

// ───────────────────────── compact / centered: top bar ─────────────────────────
function TopBar({ variant }: { variant: "compact" | "center" }) {
  const pathname = usePathname();
  const centered = variant === "center";
  const actions = <><JarvisNavActions /><SettingsAction /></>;
  // While a page's slot content (ScrollSwapBar) replaces the bar, the bar's own content rolls up and out.
  const swapped = useTopBarSlotShown();
  return (
    <>
      <Box as="header" position="sticky" top="0" zIndex="sticky" bg="bg/90" backdropFilter="blur(8px)" borderBottomWidth={centered && !swapped ? "0" : "1px"}
        overflow="hidden" borderColor={swapped ? "border" : undefined}>
        <Container maxW="7xl" css={{ containerType: "inline-size", containerName: "navbar" }} transition={SWAP_TRANSITION}
          transform={swapped ? "translateY(-100%)" : "translateY(0)"} opacity={swapped ? 0 : 1} inert={swapped} aria-hidden={swapped || undefined}>
          {centered ? (
            <Grid h="14" templateColumns="1fr auto 1fr" alignItems="center" gap="4">
              <Box><HomeLink /></Box>
              <HStack as="nav" aria-label="Sections" gap="0.5" p="1" rounded="full" bg="bg.muted" borderWidth="1px">
                {SECTIONS.map(({ href, label }) => {
                  const on = isActivePath(pathname, href);
                  return (
                    <Box asChild key={href} px="3.5" py="1" rounded="full" textStyle="sm" fontWeight="medium" whiteSpace="nowrap"
                      color={on ? "fg" : "fg.muted"} bg={on ? "bg" : undefined} shadow={on ? "xs" : undefined}
                      _hover={{ color: "fg" }}>
                      <Link href={href} aria-current={on ? "page" : undefined}>{label}</Link>
                    </Box>
                  );
                })}
              </HStack>
              <Flex justify="flex-end" gap="2"><CompactNavActions.Provider value="container">{actions}</CompactNavActions.Provider></Flex>
            </Grid>
          ) : (
            <Flex h="14" align="center" gap="6" minW="0" css={{
              "& .section-menu": { display: "none" },
              "@container navbar (max-width: 1200px)": { gap: "2" },
              "@container navbar (max-width: 1060px)": { "& .section-menu": { display: "block" }, "& .section-links": { display: "none" } },
            }}>
              <HomeLink />
              <Box className="section-menu"><SectionMenu /></Box>
              <HStack className="section-links" gap="1" as="nav" aria-label="Sections" flexShrink={0}>
                {SECTIONS.map(({ href, label }) => {
                  const on = isActivePath(pathname, href);
                  return (
                    <Box asChild key={href} px="3" py="1.5" rounded="l2" textStyle="sm" fontWeight="medium" whiteSpace="nowrap"
                      color={on ? "fg" : "fg.muted"} bg={on ? "bg.muted" : undefined} _hover={{ color: "fg", bg: "bg.muted" }}>
                      <Link href={href} aria-current={on ? "page" : undefined}>{label}</Link>
                    </Box>
                  );
                })}
              </HStack>
              <CompactNavActions.Provider value="container"><HStack ms="auto" gap="2" flexShrink={0}>{actions}</HStack></CompactNavActions.Provider>
            </Flex>
          )}
        </Container>
      </Box>
    </>
  );
}

// ───────────────────────── sidebar ─────────────────────────
function SideBar() {
  const pathname = usePathname();
  return (
    <>
      <Flex direction="column" w="60" flexShrink={0} position="sticky" top="0" h="100dvh" borderEndWidth="1px" bg="bg.subtle" px="4" py="3" overflowY="auto">
        <HomeLink />
        <Stack as="nav" aria-label="Quick actions" gap="2" mt="4"><JarvisNavActions fullWidth /><SettingsAction fullWidth /></Stack>
        <Stack as="nav" aria-label="Sections" gap="0.5" mt="6">
          {SECTIONS.map(({ href, icon: Icon, label }) => {
            const on = isActivePath(pathname, href);
            return (
              <HStack asChild key={href} gap="2.5" px="2.5" py="2" rounded="l2" textStyle="sm" fontWeight="medium"
                color={on ? "fg" : "fg.muted"} bg={on ? "bg.muted" : undefined} _hover={{ bg: "bg.muted", color: "fg" }}>
                <Link href={href} aria-current={on ? "page" : undefined}><Icon size={16} aria-hidden="true" />{label}</Link>
              </HStack>
            );
          })}
        </Stack>
      </Flex>
    </>
  );
}

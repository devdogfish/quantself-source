import { Button, Heading, HStack, Stack, Text } from "@chakra-ui/react";
import { LockKeyholeIcon } from "lucide-react";
import { useNativeAppointments, type NativeAppointment } from "./native-appointments";
import { taskTime } from "./todo-timing";

export function NativeAppointmentList({ date, enabled, onOpen }: {
  date: string;
  enabled: boolean;
  onOpen: (appointment: NativeAppointment) => void;
}) {
  const { appointments, error, retry } = useNativeAppointments(date, date, enabled);
  if (!appointments.length && !error) return null;
  return <Stack as="section" aria-label="Linked interview appointments" gap="2" px={{ base: "3", md: "6" }} py="4" maxW="8xl" mx="auto">
    <Heading size="sm">Interview appointments</Heading>
    {appointments.map(appointment => <Button key={appointment.id} size="sm" variant="outline" justifyContent="space-between" onClick={() => onOpen(appointment)}>
      <HStack minW="0"><LockKeyholeIcon aria-hidden="true" /><Text truncate>{appointment.title}</Text></HStack>
      <Text as="span" color="fg.muted" textStyle="xs">{taskTime(appointment)}</Text>
    </Button>)}
    {error && <HStack><Text role="status">{error}</Text><Button size="xs" variant="outline" onClick={retry}>Retry</Button></HStack>}
  </Stack>;
}

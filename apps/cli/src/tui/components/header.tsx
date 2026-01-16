import { Box, Text } from "ink";
import { getVersion } from "../../utils/version.js";
import { ANSI_RESET, colors, hexToAnsi } from "../styles.js";

interface HeaderProps {
  updateAvailable?: string | null;
}

export const Header = ({ updateAvailable }: HeaderProps): JSX.Element => (
  <Box flexDirection="column" marginTop={1}>
    <Text color={colors.muted}>Detent CLI {getVersion()}</Text>
    {updateAvailable ? (
      <>
        <Text color={colors.info}>
          ! {updateAvailable} available · run 'dt update'
        </Text>
        <Text> </Text>
      </>
    ) : null}
  </Box>
);

export const printHeader = (): void => {
  const mutedAnsi = hexToAnsi(colors.muted);
  console.log(`${mutedAnsi}Detent CLI ${getVersion()}${ANSI_RESET}`);
};

/**
 * Prints header with cached update check (instant, no network).
 * Cache is populated by `dt update` or periodic checks.
 *
 * NOTE: Update banner temporarily disabled to reduce latency.
 * The update logic in utils/update.ts remains intact for `dt update`.
 */
export const printHeaderWithUpdateCheck = (): void => {
  printHeader();
};

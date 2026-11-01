/**
 * TowingSpecs — Automotive Towing Calculation Engine
 *
 * Evaluates conventional towing setups against vehicle manufacturer published ratings:
 * 1. Maximum Conventional Towing Capacity (GTW)
 * 2. Hitch Tongue Weight Limit (TWR)
 * 3. Vehicle Payload Capacity (GVWR margin)
 * 4. Gross Combined Weight Rating (GCWR)
 *
 * NOTE ON SAE J2807 STANDARDIZATION:
 * Vehicle manufacturers certify their maximum vehicle ratings under rigorous physical testing
 * defined by the SAE J2807 standard (including thermal cooling, climb performance, launch,
 * braking, and hitch durability). TowingSpecs performs mathematical verification comparing
 * user-specified trailer and load weights against those certified manufacturer limits.
 * TowingSpecs does not conduct or claim dynamic vehicle certification under SAE J2807.
 */
import type {
  TowingSpec,
  TrailerCompatibilityInput,
  CompatibilityResult,
  CompatibilityResultStatus,
} from './types.ts';

export function calculateTrailerCompatibility(
  spec: TowingSpec,
  input: TrailerCompatibilityInput
): CompatibilityResult {
  const warnings: string[] = [];
  const missingInputsHelp: Array<{
    inputName: string;
    whyNeeded: string;
    howToFindOrMeasure: string;
  }> = [];

  const margins = {
    towingCapacityMarginLbs: null as number | null,
    payloadMarginLbs: null as number | null,
    tongueWeightMarginLbs: null as number | null,
    gcwrMarginLbs: null as number | null,
  };

  // --- Input validation: Guard against negative, zero, non-finite, or absurd values ---
  if (
    !Number.isFinite(input.trailerLoadedWeightLbs) ||
    input.trailerLoadedWeightLbs <= 0 ||
    !Number.isFinite(input.passengerWeightLbs) ||
    input.passengerWeightLbs < 0 ||
    !Number.isFinite(input.cargoWeightLbs) ||
    input.cargoWeightLbs < 0 ||
    (input.trailerTongueWeightLbs !== null &&
      input.trailerTongueWeightLbs !== undefined &&
      (!Number.isFinite(input.trailerTongueWeightLbs) ||
        input.trailerTongueWeightLbs < 0 ||
        input.trailerTongueWeightLbs > input.trailerLoadedWeightLbs))
  ) {
    return {
      status: 'insufficient_data',
      outcomeType: 'cannot_determine',
      outcomeHeadline: 'Cannot determine — missing critical information',
      controllingConstraint: 'Input validation error',
      margins,
      breakdown: {
        towing: {
          ratingLbs: spec.max_towing_capacity_lbs,
          loadLbs: Number.isFinite(input.trailerLoadedWeightLbs) ? input.trailerLoadedWeightLbs : 0,
          marginLbs: null,
          source: 'manufacturer',
        },
        tongueWeight: {
          ratingLbs: spec.max_tongue_weight_lbs,
          loadLbs: input.trailerTongueWeightLbs ?? null,
          marginLbs: null,
          source: 'missing',
        },
        payload: {
          ratingLbs: spec.max_payload_lbs,
          usedLbs: 0,
          marginLbs: null,
          source: 'missing',
          isComplete: false,
        },
        gcwr: {
          ratingLbs: spec.gcwr_lbs,
          combinedWeightLbs: null,
          marginLbs: null,
          source: 'manufacturer',
        },
      },
      missingInputsHelp: [
        {
          inputName: 'Valid Weight Values',
          whyNeeded: 'All weights must be positive, finite numbers to perform mechanical load verification.',
          howToFindOrMeasure: 'Check your trailer weight ticket from a certified truck scale (CAT scale) or RV weigh station.',
        },
      ],
      explanation:
        'Calculation cannot proceed due to invalid input values. Weight values must be finite, non-negative numbers, trailer loaded weight must be greater than zero, and tongue weight cannot exceed total trailer weight.',
      warnings: ['Invalid input: negative, zero, non-finite, or physically impossible weight values provided.'],
      isEstimate: true,
    };
  }

  const violations: { constraint: string; message: string; status: CompatibilityResultStatus }[] = [];

  // --- 1. Towing capacity check (including zero-towing vehicles) ---
  if (spec.max_towing_capacity_lbs !== null && spec.max_towing_capacity_lbs !== undefined) {
    margins.towingCapacityMarginLbs = spec.max_towing_capacity_lbs - input.trailerLoadedWeightLbs;
    if (spec.max_towing_capacity_lbs === 0) {
      violations.push({
        constraint: 'Manufacturer zero-towing rating (Towing not recommended)',
        status: 'exceeds_towing_capacity',
        message: `Trailer towing is NOT recommended by the vehicle manufacturer for this vehicle configuration (rated capacity: 0 lbs). The vehicle is not engineered or approved for trailer loads.`,
      });
    } else if (margins.towingCapacityMarginLbs < 0) {
      violations.push({
        constraint: 'Maximum towing capacity',
        status: 'exceeds_towing_capacity',
        message: `The trailer's loaded weight of ${input.trailerLoadedWeightLbs.toLocaleString()} lbs exceeds the vehicle's maximum towing capacity of ${spec.max_towing_capacity_lbs.toLocaleString()} lbs by ${Math.abs(margins.towingCapacityMarginLbs).toLocaleString()} lbs.`,
      });
    } else if (margins.towingCapacityMarginLbs < 500) {
      warnings.push(
        'Trailer weight is within 500 lbs of the maximum rated towing capacity. This leaves very little margin for weight distribution errors or added cargo.'
      );
    }
  } else {
    warnings.push('Towing capacity data is unavailable for this configuration. Cannot confirm this setup is within limits.');
    missingInputsHelp.push({
      inputName: 'Manufacturer Towing Capacity',
      whyNeeded: 'The vehicle manufacturer maximum conventional tow rating is required to confirm physical pulling capability.',
      howToFindOrMeasure: 'Consult your vehicle owner manual under the "Driving Information — Trailer Towing" section.',
    });
  }

  // --- 2. Tongue weight check ---
  const hasTongueWeight =
    input.trailerTongueWeightLbs !== null &&
    input.trailerTongueWeightLbs !== undefined;

  if (hasTongueWeight) {
    if (spec.max_tongue_weight_lbs !== null && spec.max_tongue_weight_lbs !== undefined) {
      margins.tongueWeightMarginLbs = spec.max_tongue_weight_lbs - input.trailerTongueWeightLbs!;
      if (margins.tongueWeightMarginLbs < 0) {
        violations.push({
          constraint: 'Maximum hitch receiver tongue weight',
          status: 'exceeds_tongue_weight',
          message: `The tongue weight of ${input.trailerTongueWeightLbs!.toLocaleString()} lbs exceeds the vehicle's rated tongue weight limit of ${spec.max_tongue_weight_lbs.toLocaleString()} lbs by ${Math.abs(margins.tongueWeightMarginLbs).toLocaleString()} lbs.`,
        });
      }
    }

    // Tongue weight ratio check (10% - 15% general conventional-trailer guidance)
    const tonguePct = (input.trailerTongueWeightLbs! / input.trailerLoadedWeightLbs) * 100;
    if (tonguePct < 10) {
      warnings.push(
        `Calculated tongue weight is only ${tonguePct.toFixed(1)}% of trailer weight. General conventional bumper-pull guidance recommends 10% to 15% to mitigate trailer sway (boat trailers, utility trailers, or gooseneck/5th-wheels follow different manufacturer guidelines).`
      );
    } else if (tonguePct > 15) {
      warnings.push(
        `Calculated tongue weight is ${tonguePct.toFixed(1)}% of trailer weight. General conventional trailer guidance targets 10% to 15%; exceeding 15% places excessive strain on the vehicle's rear axle and hitch receiver, which may overload vehicle payload or lift the front steering axle.`
      );
    }
  } else {
    warnings.push('Tongue weight was not provided. Tongue weight and payload limits are separate critical constraints that must be measured and verified.');
    missingInputsHelp.push({
      inputName: 'Trailer Tongue Weight',
      whyNeeded: 'Tongue weight (the downward force on the hitch ball) transfers directly onto your vehicle and consumes payload capacity. Without tongue weight, vehicle payload compliance cannot be verified.',
      howToFindOrMeasure: 'Use a portable trailer tongue weight scale at the trailer coupler, or weigh your vehicle at a certified CAT scale before and after hitching the trailer. Conventional travel trailers typically transfer 10%–15% of total loaded trailer weight to the tongue.',
    });
  }

  // --- 3. Payload check ---
  const occupantAndCargoWeight = input.passengerWeightLbs + input.cargoWeightLbs;
  // Note: We do NOT silently assume 0 tongue weight when calculating payload completeness
  const tongueWeightForPayload = hasTongueWeight ? input.trailerTongueWeightLbs! : 0;
  const totalPayloadUsed = occupantAndCargoWeight + tongueWeightForPayload;

  // Check if user entered their vehicle's exact driver door-jamb sticker payload
  const useCustomPayload =
    typeof input.customPayloadLbs === 'number' &&
    Number.isFinite(input.customPayloadLbs) &&
    input.customPayloadLbs > 0;

  const effectivePayloadLbs = useCustomPayload
    ? input.customPayloadLbs!
    : (spec.max_payload_lbs ?? null);

  if (!useCustomPayload) {
    missingInputsHelp.push({
      inputName: 'Driver B-Pillar Door-Jamb Payload',
      whyNeeded: 'Factory-installed options (sunroof, skid plates, audio systems, power running boards) reduce your vehicle\'s actual payload capacity below base brochure figures.',
      howToFindOrMeasure: 'Open the driver\'s door and locate the yellow and white "Tire and Loading Information" placard on the B-pillar jamb. Find the exact sentence: "The combined weight of occupants and cargo should never exceed XXXX lbs."',
    });
  }

  if (effectivePayloadLbs !== null && effectivePayloadLbs !== undefined) {
    margins.payloadMarginLbs = effectivePayloadLbs - totalPayloadUsed;
    if (margins.payloadMarginLbs < 0) {
      violations.push({
        constraint: useCustomPayload
          ? 'Actual door-jamb payload limit'
          : 'Vehicle payload capacity',
        status: 'exceeds_payload',
        message: `The combined weight of passengers (${input.passengerWeightLbs.toLocaleString()} lbs), cargo (${input.cargoWeightLbs.toLocaleString()} lbs), and tongue weight (${tongueWeightForPayload.toLocaleString()} lbs) totals ${totalPayloadUsed.toLocaleString()} lbs, which exceeds the ${useCustomPayload ? 'door-jamb sticker payload limit' : "vehicle's payload rating"} of ${effectivePayloadLbs.toLocaleString()} lbs by ${Math.abs(margins.payloadMarginLbs).toLocaleString()} lbs.`,
      });
    } else if (!hasTongueWeight && occupantAndCargoWeight > effectivePayloadLbs) {
      violations.push({
        constraint: 'Occupant and cargo payload limit',
        status: 'exceeds_payload',
        message: `Passenger and cargo weight alone (${occupantAndCargoWeight.toLocaleString()} lbs) exceeds the vehicle's payload capacity of ${effectivePayloadLbs.toLocaleString()} lbs by ${(occupantAndCargoWeight - effectivePayloadLbs).toLocaleString()} lbs, before even attaching trailer tongue weight.`,
      });
    }
  } else {
    warnings.push('Payload capacity data is unavailable. Payload is a critical constraint independent of towing capacity.');
    missingInputsHelp.push({
      inputName: 'Vehicle Payload Rating',
      whyNeeded: 'Payload limit governs the maximum weight your vehicle\'s springs, frame, and axles can safely support.',
      howToFindOrMeasure: 'Look at the Tire and Loading Information placard on your driver-side door jamb.',
    });
  }

  // --- 4. GCWR check ---
  let combinedWeight: number | null = null;
  if (
    spec.gcwr_lbs !== null &&
    spec.gcwr_lbs !== undefined &&
    spec.curb_weight_lbs !== null &&
    spec.curb_weight_lbs !== undefined
  ) {
    combinedWeight =
      spec.curb_weight_lbs + occupantAndCargoWeight + input.trailerLoadedWeightLbs;
    margins.gcwrMarginLbs = spec.gcwr_lbs - combinedWeight;
    if (margins.gcwrMarginLbs < 0) {
      violations.push({
        constraint: 'Gross Combined Weight Rating (GCWR)',
        status: 'exceeds_gcwr',
        message: `The combined weight of ${combinedWeight.toLocaleString()} lbs exceeds the vehicle's GCWR of ${spec.gcwr_lbs.toLocaleString()} lbs by ${Math.abs(margins.gcwrMarginLbs).toLocaleString()} lbs.`,
      });
    }
  } else if (spec.gcwr_lbs === null || spec.gcwr_lbs === undefined) {
    warnings.push('GCWR (Gross Combined Weight Rating) is unavailable for this configuration.');
  }

  // --- Add equipment notes if applicable ---
  if (spec.equipment_notes) {
    warnings.push(`Equipment requirement: ${spec.equipment_notes}`);
  }

  // --- Tongue weight estimate disclaimer ---
  if (input.isTongueWeightEstimated) {
    warnings.push('Tongue weight is labeled as an estimate (percentage-based). Actual loaded trailer tongue weight should be verified with a certified scale.');
  }

  // --- Jurisdictional & OEM Trailer Brake Guidance ---
  let trailerBrakeRequirement: string | undefined = undefined;
  if (input.trailerLoadedWeightLbs > 1500) {
    trailerBrakeRequirement = 'Trailer Brakes Required: Most vehicle manufacturers mandate auxiliary trailer brakes for loads over 1,000–1,500 lbs. Legal thresholds also vary across US state jurisdictions (from 1,500 lbs in ID/NH to 3,000 lbs in CA/TX). Verify both vehicle manufacturer guidelines and your state DOT requirements.';
    warnings.push(trailerBrakeRequirement);
  }

  // --- Breakdown generation ---
  const breakdown: CompatibilityResult['breakdown'] = {
    towing: {
      ratingLbs: spec.max_towing_capacity_lbs,
      loadLbs: input.trailerLoadedWeightLbs,
      marginLbs: margins.towingCapacityMarginLbs,
      source: 'manufacturer',
    },
    tongueWeight: {
      ratingLbs: spec.max_tongue_weight_lbs,
      loadLbs: input.trailerTongueWeightLbs ?? null,
      marginLbs: margins.tongueWeightMarginLbs,
      source: hasTongueWeight ? (input.isTongueWeightEstimated ? 'user_estimated' : 'user_measured') : 'missing',
    },
    payload: {
      ratingLbs: effectivePayloadLbs,
      usedLbs: totalPayloadUsed,
      marginLbs: margins.payloadMarginLbs,
      source: useCustomPayload
        ? 'user_door_jamb_sticker'
        : (spec.max_payload_lbs !== null ? 'manufacturer_brochure_baseline' : 'missing'),
      isComplete: hasTongueWeight && effectivePayloadLbs !== null,
    },
    gcwr: {
      ratingLbs: spec.gcwr_lbs,
      combinedWeightLbs: combinedWeight,
      marginLbs: margins.gcwrMarginLbs,
      source: 'manufacturer',
    },
  };

  // --- Evaluate violations ---
  if (violations.length > 1) {
    return {
      status: 'multiple_violations',
      outcomeType: 'exceeds_limits',
      outcomeHeadline: 'Exceeds a specified limit',
      controllingConstraint: violations.map((v) => v.constraint).join(', '),
      margins,
      breakdown,
      missingInputsHelp,
      explanation: `Multiple manufacturer limits exceeded: ${violations.map((v) => v.message).join(' ')}`,
      warnings,
      isEstimate: false,
      usedCustomPayload: useCustomPayload,
      effectivePayloadLbs,
      trailerBrakeRequirement,
    };
  }

  if (violations.length === 1) {
    return {
      status: violations[0].status,
      outcomeType: 'exceeds_limits',
      outcomeHeadline: 'Exceeds a specified limit',
      controllingConstraint: violations[0].constraint,
      margins,
      breakdown,
      missingInputsHelp,
      explanation: violations[0].message,
      warnings,
      isEstimate: false,
      usedCustomPayload: useCustomPayload,
      effectivePayloadLbs,
      trailerBrakeRequirement,
    };
  }

  // All evaluated constraints passed without violation, but check for missing data
  const isEstimate =
    spec.max_payload_lbs === null ||
    spec.max_payload_lbs === undefined ||
    spec.gcwr_lbs === null ||
    spec.gcwr_lbs === undefined ||
    spec.max_towing_capacity_lbs === null ||
    spec.max_towing_capacity_lbs === undefined ||
    !hasTongueWeight;

  if (isEstimate) {
    warnings.push('Some critical ratings could not be evaluated due to missing data. This result is a partial assessment only and cannot guarantee safe operation.');
  }

  // Determine the most restrictive constraint margin
  let controllingConstraint = 'Towing capacity';
  let smallestMargin = margins.towingCapacityMarginLbs ?? Infinity;

  if (margins.payloadMarginLbs !== null && margins.payloadMarginLbs < smallestMargin) {
    smallestMargin = margins.payloadMarginLbs;
    controllingConstraint = 'Payload capacity';
  }
  if (margins.tongueWeightMarginLbs !== null && margins.tongueWeightMarginLbs < smallestMargin) {
    smallestMargin = margins.tongueWeightMarginLbs;
    controllingConstraint = 'Tongue weight';
  }
  if (margins.gcwrMarginLbs !== null && margins.gcwrMarginLbs < smallestMargin) {
    smallestMargin = margins.gcwrMarginLbs;
    controllingConstraint = 'GCWR';
  }

  const outcomeType = isEstimate ? 'cannot_determine' : 'within_limits';
  const outcomeHeadline = isEstimate
    ? 'Cannot determine — missing critical information'
    : 'Within the supplied limits';

  return {
    status: isEstimate ? 'insufficient_data' : 'within_all_limits',
    outcomeType,
    outcomeHeadline,
    controllingConstraint,
    margins,
    breakdown,
    missingInputsHelp,
    explanation: isEstimate
      ? 'Based on available data, the setup does not exceed evaluated limits. However, missing constraint data (such as measured tongue weight or exact door-jamb payload) prevents an unconditional determination.'
      : `This setup is within all evaluated limits. The controlling constraint is ${controllingConstraint.toLowerCase()}, with a margin of ${(smallestMargin === Infinity ? 0 : smallestMargin).toLocaleString()} lbs remaining.`,
    warnings,
    isEstimate,
    usedCustomPayload: useCustomPayload,
    effectivePayloadLbs,
    trailerBrakeRequirement,
  };
}

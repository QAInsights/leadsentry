import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OsmAddressSampler, type SampledAddress } from '../src/zip/addressSampler.js';

const TEST_DIR = join('test-tmp-sampler');

function stubTIGERwebResponse(geoid: string): object {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { GEOID: geoid, NAME: 'Census Tract 65.01' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-78.88822, 42.91609],
              [-78.8883, 42.91534],
              [-78.87705, 42.91547],
              [-78.87701, 42.92036],
              [-78.88104, 42.92031],
              [-78.88177, 42.91983],
              [-78.88235, 42.92029],
              [-78.88792, 42.9202],
              [-78.88816, 42.91851],
              [-78.88806, 42.91753],
              [-78.88822, 42.91609],
            ],
          ],
        },
      },
    ],
  };
}

const THREE_ADDRESSES: SampledAddress[] = [
  { address: '100 Test Ave, Buffalo, 14213', lat: 42.918, lng: -78.885, source: 'OpenStreetMap contributors (ODbL)' },
  { address: '102 Test Ave, Buffalo, 14213', lat: 42.919, lng: -78.884, source: 'OpenStreetMap contributors (ODbL)' },
  { address: '200 Other St, Buffalo', lat: 42.917, lng: -78.886, source: 'OpenStreetMap contributors (ODbL)' },
];

const TWO_ADDRESSES_NO_POSTCODE: SampledAddress[] = [
  { address: '1 A St, Buffalo', lat: 42.9, lng: -78.88, source: 'OpenStreetMap contributors (ODbL)' },
  { address: '2 A St, Buffalo', lat: 42.91, lng: -78.88, source: 'OpenStreetMap contributors (ODbL)' },
];

async function writeCache(sampler: OsmAddressSampler, geoid: string, tract: object, addrs: SampledAddress[]): Promise<void> {
  await mkdir(TEST_DIR, { recursive: true });
  await writeFile(join(TEST_DIR, `tract-poly-${geoid}.json`), JSON.stringify(tract));
  await writeFile(join(TEST_DIR, `tract-addrs-${geoid}.json`), JSON.stringify(addrs));
}

describe('OsmAddressSampler', () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });
  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('deterministic spread sample picks N addresses sorted by lat', async () => {
    const sampler = new OsmAddressSampler(TEST_DIR);
    await writeCache(sampler, '36029006501', stubTIGERwebResponse('36029006501'), THREE_ADDRESSES);

    const result = await sampler.sampleAddresses('36029006501', 2);
    expect(result.skippedReason).toBeNull();
    expect(result.addresses.length).toBe(2);
    expect(result.provenance).toContain('OpenStreetMap');

    // With 3 addresses sorted by lat (42.917, 42.918, 42.919) and step=1,
    // we should get the first two: 200 Other St and 100 Test Ave.
    const addrs = result.addresses.map((a) => a.address);
    expect(addrs[0]).toContain('Other St');
    expect(addrs[1]).toContain('100 Test Ave');
  });

  it('returns skipped when no addresses are found', async () => {
    const sampler = new OsmAddressSampler(TEST_DIR);
    await writeCache(sampler, '36029006501', stubTIGERwebResponse('36029006501'), []);

    const result = await sampler.sampleAddresses('36029006501', 2);
    expect(result.addresses.length).toBe(0);
    expect(result.skippedReason).toContain('No OSM addresses');
  });

  it('back-fills from the end when fewer than N addresses exist', async () => {
    const sampler = new OsmAddressSampler(TEST_DIR);
    await writeCache(sampler, '36029006501', stubTIGERwebResponse('36029006501'), TWO_ADDRESSES_NO_POSTCODE);

    const result = await sampler.sampleAddresses('36029006501', 5);
    expect(result.addresses.length).toBe(2);
    expect(result.addresses[0].address).toBe('1 A St, Buffalo');
  });

  it('qualifies missing postcode with provided zip', async () => {
    const sampler = new OsmAddressSampler(TEST_DIR);
    await writeCache(sampler, '36029006501', stubTIGERwebResponse('36029006501'), TWO_ADDRESSES_NO_POSTCODE);

    const result = await sampler.sampleAddresses('36029006501', 1, { zip: '14213' });
    expect(result.addresses[0].address).toContain('14213');
  });
});

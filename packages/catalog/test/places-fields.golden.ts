// Golden SKU per Places field and endpoint, generated from the source table at
// https://developers.google.com/maps/documentation/places/web-service/data-fields (updated 2026-10-28).
// Kept separate from data/google-maps/places-fields.yaml so a bad edit there fails the tests.
// null: the endpoint does not offer the field.
export const GOLDEN: Record<string, [string | null, string | null, string | null]> = {
  accessibilityOptions: [
    'places.details.pro',
    'places.text_search.pro',
    'places.nearby_search.pro',
  ],
  addressComponents: [
    'places.details.essentials',
    'places.text_search.pro',
    'places.nearby_search.pro',
  ],
  addressDescriptor: [
    'places.details.essentials',
    'places.text_search.pro',
    'places.nearby_search.pro',
  ],
  adrFormatAddress: [
    'places.details.essentials',
    'places.text_search.pro',
    'places.nearby_search.pro',
  ],
  allowsDogs: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  attributions: [
    'places.details.ids_only',
    'places.text_search.ids_only',
    'places.nearby_search.pro',
  ],
  businessStatus: ['places.details.pro', 'places.text_search.pro', 'places.nearby_search.pro'],
  consumerAlert: [
    'places.details.ids_only',
    'places.text_search.ids_only',
    'places.nearby_search.pro',
  ],
  containingPlaces: ['places.details.pro', 'places.text_search.pro', 'places.nearby_search.pro'],
  curbsidePickup: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  currentOpeningHours: [
    'places.details.enterprise',
    'places.text_search.enterprise',
    'places.nearby_search.enterprise',
  ],
  currentSecondaryOpeningHours: [
    'places.details.enterprise',
    'places.text_search.enterprise',
    'places.nearby_search.enterprise',
  ],
  delivery: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  dineIn: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  displayName: ['places.details.pro', 'places.text_search.pro', 'places.nearby_search.pro'],
  editorialSummary: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  entrances: ['places.details.pro', 'places.text_search.pro', 'places.nearby_search.pro'],
  evChargeAmenitySummary: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  evChargeOptions: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  formattedAddress: [
    'places.details.essentials',
    'places.text_search.pro',
    'places.nearby_search.pro',
  ],
  fuelOptions: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  generativeSummary: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  goodForChildren: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  goodForGroups: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  goodForWatchingSports: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  googleMapsLinks: ['places.details.pro', 'places.text_search.pro', 'places.nearby_search.pro'],
  googleMapsTypeLabel: ['places.details.pro', 'places.text_search.pro', 'places.nearby_search.pro'],
  googleMapsUri: ['places.details.pro', 'places.text_search.pro', 'places.nearby_search.pro'],
  iconBackgroundColor: ['places.details.pro', 'places.text_search.pro', 'places.nearby_search.pro'],
  iconMaskBaseUri: ['places.details.pro', 'places.text_search.pro', 'places.nearby_search.pro'],
  id: ['places.details.ids_only', 'places.text_search.ids_only', 'places.nearby_search.pro'],
  internationalPhoneNumber: [
    'places.details.enterprise',
    'places.text_search.enterprise',
    'places.nearby_search.enterprise',
  ],
  liveMusic: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  location: ['places.details.essentials', 'places.text_search.pro', 'places.nearby_search.pro'],
  menuForChildren: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  movedPlace: [
    'places.details.ids_only',
    'places.text_search.ids_only',
    'places.nearby_search.pro',
  ],
  movedPlaceId: [
    'places.details.ids_only',
    'places.text_search.ids_only',
    'places.nearby_search.pro',
  ],
  name: ['places.details.ids_only', 'places.text_search.ids_only', 'places.nearby_search.pro'],
  nationalPhoneNumber: [
    'places.details.enterprise',
    'places.text_search.enterprise',
    'places.nearby_search.enterprise',
  ],
  navigationPoints: ['places.details.pro', 'places.text_search.pro', 'places.nearby_search.pro'],
  neighborhoodSummary: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  nextPageToken: [null, 'places.text_search.ids_only', null],
  openingDate: ['places.details.pro', 'places.text_search.pro', 'places.nearby_search.pro'],
  outdoorSeating: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  parkingOptions: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  paymentOptions: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  photos: ['places.details.ids_only', 'places.text_search.pro', 'places.nearby_search.pro'],
  plusCode: ['places.details.essentials', 'places.text_search.pro', 'places.nearby_search.pro'],
  postalAddress: [
    'places.details.essentials',
    'places.text_search.pro',
    'places.nearby_search.pro',
  ],
  priceLevel: [
    'places.details.enterprise',
    'places.text_search.enterprise',
    'places.nearby_search.enterprise',
  ],
  priceRange: [
    'places.details.enterprise',
    'places.text_search.enterprise',
    'places.nearby_search.enterprise',
  ],
  primaryType: ['places.details.pro', 'places.text_search.pro', 'places.nearby_search.pro'],
  primaryTypeDisplayName: [
    'places.details.pro',
    'places.text_search.pro',
    'places.nearby_search.pro',
  ],
  pureServiceAreaBusiness: [
    'places.details.pro',
    'places.text_search.pro',
    'places.nearby_search.pro',
  ],
  rating: [
    'places.details.enterprise',
    'places.text_search.enterprise',
    'places.nearby_search.enterprise',
  ],
  regularOpeningHours: [
    'places.details.enterprise',
    'places.text_search.enterprise',
    'places.nearby_search.enterprise',
  ],
  regularSecondaryOpeningHours: [
    'places.details.enterprise',
    'places.text_search.enterprise',
    'places.nearby_search.enterprise',
  ],
  reservable: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  restroom: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  reviewSummary: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  reviews: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  routingSummaries: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  servesBeer: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  servesBreakfast: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  servesBrunch: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  servesCocktails: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  servesCoffee: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  servesDessert: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  servesDinner: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  servesLunch: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  servesVegetarianFood: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  servesWine: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  shortFormattedAddress: [
    'places.details.essentials',
    'places.text_search.pro',
    'places.nearby_search.pro',
  ],
  subDestinations: ['places.details.pro', 'places.text_search.pro', 'places.nearby_search.pro'],
  takeout: [
    'places.details.enterprise_atmosphere',
    'places.text_search.enterprise_atmosphere',
    'places.nearby_search.enterprise_atmosphere',
  ],
  timeZone: ['places.details.pro', 'places.text_search.pro', 'places.nearby_search.pro'],
  transitStation: [
    'places.details.enterprise',
    'places.text_search.enterprise',
    'places.nearby_search.enterprise',
  ],
  types: ['places.details.essentials', 'places.text_search.pro', 'places.nearby_search.pro'],
  userRatingCount: [
    'places.details.enterprise',
    'places.text_search.enterprise',
    'places.nearby_search.enterprise',
  ],
  utcOffsetMinutes: ['places.details.pro', 'places.text_search.pro', 'places.nearby_search.pro'],
  viewport: ['places.details.essentials', 'places.text_search.pro', 'places.nearby_search.pro'],
  websiteUri: [
    'places.details.enterprise',
    'places.text_search.enterprise',
    'places.nearby_search.enterprise',
  ],
};

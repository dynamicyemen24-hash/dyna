import React, { createContext, useContext, useState, useEffect } from 'react';
import { apiGet } from '../services/dyposApi';
import { IndustryProfile, getProfileById, capabilitiesForProfile, industryProfiles } from '../config/industryProfiles';

interface IndustryContextType {
  activeProfile: IndustryProfile;
  setProfile: (id: string) => void;
  hasCapability: (capabilityId: string) => boolean;
  isLoading: boolean;
  /** Screens the active sector may open — drives the sidebar and the guard. */
  allowedTabs: string[];
  /** Convenience predicate for hiding or blocking a screen. */
  canOpenTab: (tab: string) => boolean;
}

const IndustryContext = createContext<IndustryContextType | undefined>(undefined);

export const IndustryProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [profileId, setProfileId] = useState<string>(localStorage.getItem('dypos_industry_profile') || 'retail');
  // Seeded with the sector defaults rather than an empty set: an empty array made
  // `hasCapability` false for every screen until the profile request returned,
  // so the sidebar visibly emptied and repopulated on every mount.
  const [enabledCapabilities, setEnabledCapabilities] = useState<string[]>(
    () => capabilitiesForProfile(localStorage.getItem('dypos_industry_profile') || 'retail'),
  );
  const [isLoading, setIsLoading] = useState(true);

  const activeProfile = getProfileById(profileId);

  useEffect(() => {
    const fetchProfile = async () => {
      try {
        // The raw `fetch` here sent `?tenantId=royal-global-hq` and NO session token.
        // That matters more here than anywhere else: this response decides which
        // capabilities the tenant has, so a client-supplied tenant string was
        // being used to pick another tenant's sector profile and features. The
        // server now derives it from the signed session.
        const data = await apiGet<{
          profileId?: string;
          enabledCapabilities?: string[];
        }>('/api/db/tenant/profile');
        if (data.profileId) {
          setProfileId(data.profileId);
          localStorage.setItem('dypos_industry_profile', data.profileId);
        }
        if (Array.isArray(data.enabledCapabilities) && data.enabledCapabilities.length) {
          setEnabledCapabilities(data.enabledCapabilities);
        } else {
          // The tenant has no explicit grant rows. An empty array here is NOT a
          // licence denial, it just means nothing was provisioned yet — treating
          // it as authoritative hid every capability-gated screen behind an empty
          // set, so the sector's own defaults are the correct fallback.
          setEnabledCapabilities(capabilitiesForProfile(activeProfile.id));
        }
      } catch (err) {
        console.error('Failed to sync industry profile:', err);
        // Fallback to local storage
        setEnabledCapabilities(capabilitiesForProfile(activeProfile.id));
      } finally {
        setIsLoading(false);
      }
    };

    fetchProfile();
  }, [profileId]);

  const updateProfileOnServer = async (id: string) => {
    setIsLoading(true);
    try {
      // Unknown ids fall back to the default profile, so guard explicitly rather
      // than silently switching the operator to a sector they did not pick.
      if (!industryProfiles.some((p) => p.id === id)) {
        console.warn(`Unknown industry profile "${id}" — keeping ${profileId}`);
        return;
      }
      setProfileId(id);
      localStorage.setItem('dypos_industry_profile', id);
      // Capabilities follow from the newly selected sector's screens, so the
      // sidebar updates in the same tick instead of after a fabricated delay.
      setEnabledCapabilities(capabilitiesForProfile(id));
    } catch (err) {
      console.error('Failed to update profile:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const hasCapability = (capabilityId: string) => {
    // If we have specific capabilities from server, use them, otherwise fallback to profile default
    return enabledCapabilities.includes(capabilityId);
  };

  const allowedTabs = activeProfile.tabs;
  const canOpenTab = (tab: string) => allowedTabs.includes(tab);

  return (
    <IndustryContext.Provider
      value={{ activeProfile, setProfile: updateProfileOnServer, hasCapability, isLoading, allowedTabs, canOpenTab }}
    >
      {children}
    </IndustryContext.Provider>
  );
};

export const useIndustry = () => {
  const context = useContext(IndustryContext);
  if (context === undefined) {
    throw new Error('useIndustry must be used within an IndustryProvider');
  }
  return context;
};

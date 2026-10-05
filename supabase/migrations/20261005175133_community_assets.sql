-- Only approved community QR codes belong here. Parcel evidence stays private.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('community-assets','community-assets',true,2097152,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=true,file_size_limit=excluded.file_size_limit,
allowed_mime_types=excluded.allowed_mime_types;
-- No anonymous/authenticated INSERT, UPDATE or DELETE policy is created.

-- Pin the remaining helper's lookup path, as required by the security advisor.
alter function public.cmi_contact_valid(jsonb) set search_path='';

-- The documents bucket's own limits, on their own so that nothing else waits on them: should a hosted project refuse
-- this write to storage.buckets, set the same two limits in the dashboard (Storage, the documents bucket's settings).
--
-- What the app files and members upload: quotes, receipts and drawings as PDF, photos as PNG or JPEG, notes as plain
-- text. Storage refuses anything else, and anything over 5 MB, for everyone (the service role too).
update storage.buckets
   set file_size_limit = 5242880,
       allowed_mime_types = array['application/pdf', 'image/png', 'image/jpeg', 'text/plain']
 where id = 'documents';

-- Mock mode used to mark our templates approved. Only templates that Meta approved (they have a Meta id) stay approved.
update templates set status = 'pending' where meta_template_id is null and status = 'approved';
